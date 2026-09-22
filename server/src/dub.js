import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { readPack, orderClips, extractPackZip, writeZip, wavInfo, safeName } from './dubfiles.js';
import { checkStorage, storageAdd, storageLeft } from './limits.js';
import { ffmpeg, findFfmpeg, probe } from './ffjobs.js';
import { count as countStat, observe as observeStat } from './stats.js';

/* =====================================================================
 * Dub-Modus (Synchronisieren): ein Video, jeder spricht die Zeilen seiner Figuren.
 *
 * Wie im Steam-Mehrspieler des Spiels:
 *   HUB       Pack wählen, Figuren claimen, „der Reihe nach“ an/aus, Pack laden, Start
 *   PLAYING   Zeile für Zeile: wer dran ist, hört den Clip und nimmt auf, die anderen schauen zu
 *   PAUSED    wer dran ist, hat die Verbindung verloren (20 s, dann weiter ohne ihn)
 *   RESULTS   Ergebnis, gemeinsam anschauen, als Video exportieren
 *
 * Das Pack kommt entweder aus dem Spiel (Mod lädt es hoch) oder aus dem Browser (ZIP oder Ordner).
 * Zeile mit mehreren Figuren: jeder, der eine davon hat, nimmt getrennt auf, am Ende wird gemischt.
 * ===================================================================== */

const MB = 1024 * 1024;
const MAX_PACK = (Number(process.env.DUB_MAX_PACK_MB) || 800) * MB;
// Längstes Video für Export und Umwandlung: ein kleines Pack kann ein stundenlanges Video enthalten
const MAX_VIDEO_S = (Number(process.env.DUB_MAX_VIDEO_MIN) || 20) * 60;
// Datenordner aller Räume (für die Speichergrenze in limits.js)
const dataDirOf = (room) => path.dirname(room.dir);

/** Größe aller Dateien direkt in einem Ordner. */
function folderBytes(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { n += fs.statSync(path.join(dir, f)).size; } catch {}
    }
  } catch {}
  return n;
}
const MAX_TAKE = (Number(process.env.DUB_MAX_TAKE_MB) || 25) * MB;
const PAUSE_GRACE_MS = 20000;
const OFFER_MS = 60000;        // so lange steht ein Angebot, eine Zeile abzugeben
const WATCH_LEAD_MS = 2500;
const SR = 44100;
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const key = (clipId, pid) => `${clipId}\n${pid}`;

const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska' };
const FILE_MIME = {
  ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', opus: 'audio/ogg', aac: 'audio/aac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8',
};
const extOf = (f) => path.extname(f).slice(1).toLowerCase();

function slug(s) {
  return String(s || 'Dub').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Dub';
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

/* ---------------------------------------------------------------------
 * Sitzung
 * ------------------------------------------------------------------- */

export class DubSession {
  constructor(room, source) {
    this.room = room;
    this.dir = path.join(room.dir, 'dub');
    for (const d of ['pack', 'web', 'takes', 'work']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    this.source = source;              // 'browser' | 'game'
    this.leaderId = null;              // wer den Raum im Browser erstellt hat
    this.pack = null;                  // eingelesenes Pack
    this.clips = new Map();            // id -> Zeile
    this.version = 0;                  // steigt mit jedem neuen Pack
    this.orderVersion = 0;             // steigt, wenn nur die Reihenfolge wechselt
    this.packStatus = { status: 'none', error: null, note: null };   // none | uploading | processing | ready | error
    this.video = { status: 'none', pct: 0, file: null, mime: null, duration: 0, height: 0, codec: null, h264: false };
    this.orderMode = 'chrono';
    this.order = [];
    this.useAsIs = new Set();
    this.claims = new Map();           // Figur -> Spieler
    this.chrono = false;               // „der Reihe nach“
    this.spectators = new Set();
    this.phase = 'hub';                // hub | playing | paused | results
    this.startedAt = null;             // Beginn der laufenden Dub-Runde (nur für die Statistik)
    this.plan = null;                  // fortlaufendes Hochladen aus dem Spiel, siehe beginUpload
    this.waitClip = null;              // Zeile, deren Dateien noch unterwegs sind
    this.offer = null;                 // laufende Zeile jemand anderem angeboten, siehe offerLine
    this.offerTimer = null;
    this.turns = [];                   // [{clipId, index, recorders:[pid]}]
    this.turnIndex = -1;
    this.takes = new Map();            // key -> {clipId, playerId, name, file, at, score}
    this.skipped = new Set();
    this.ready = new Map();            // pid -> {have, need}
    this.activity = new Map();         // pid -> {what, at}
    this.pause = null;
    this.pauseTimer = null;
    this.watch = null;
    this.chat = [];
    this.gameScores = new Map();       // clipId -> 0..100, vom Spiel berechnet
    this.gameDone = false;             // Spiel am PC hat die letzte Zeile verarbeitet (erst dann gemeinsam anschauen)
    this.exportJob = { status: 'idle', pct: 0, error: null, file: null, name: null };
    this.onChange = () => {};
    this.onEvent = () => {};
  }

  /* ---------- Rechte ---------- */

  /** Spielleiter: wer den Raum im Browser erstellt hat, sonst der erste verbundene Web-Spieler.
   *  Hat das Spiel den Raum eröffnet, leitet der PC (null: kein Handy hat Leitungsrechte). */
  leaderPid() {
    if (this.source === 'game') return null;
    const phones = [...this.room.players.values()].filter((p) => p.kind === 'phone' && !p.left).sort((a, b) => a.joinOrder - b.joinOrder);
    const lead = phones.find((p) => p.id === this.leaderId);
    if (lead?.connected) return lead.id;
    return phones.find((p) => p.connected)?.id || lead?.id || null;
  }

  isLeader(pid) {
    return !!pid && this.leaderPid() === pid;
  }

  canUpload(pid) {
    return this.source !== 'game' && this.isLeader(pid) && this.phase === 'hub';
  }

  /* ---------- Pack ---------- */

  packDir() { return path.join(this.dir, 'pack'); }
  stagingDir() { return path.join(this.dir, 'staging'); }

  /** Ordner, in den gerade hochgeladen wird: fortlaufend direkt ins Pack, sonst nebenan. */
  uploadDir() {
    return this.plan ? this.packDir() : this.stagingDir();
  }

  /** Hochladen beginnen.
   *  Ohne Plan (Browser): alles landet neben dem Pack und wird erst beim Übernehmen gültig.
   *  Mit Plan (Spiel): das Spiel meldet vorher alle Dateien, ihre Größe und die Reihenfolge.
   *  Dann entstehen die Zeilen sofort, die Dateien kommen nach und die Runde kann schon starten. */
  beginUpload(plan = null) {
    if (this.phase !== 'hub') throw new Error('Das Pack kann nur in der Lobby gewechselt werden.');
    this.plan = null;
    this.waitClip = null;
    clearTimeout(this.rescanTimer);
    this.rescanTimer = null;
    if (!plan) {
      fs.rmSync(this.stagingDir(), { recursive: true, force: true });
      fs.mkdirSync(this.stagingDir(), { recursive: true });
      this.packStatus = { status: 'uploading', error: null, note: null };
      return;
    }
    const files = new Map();
    for (const f of Array.isArray(plan.files) ? plan.files.slice(0, 5000) : []) {
      const name = safeName(f?.name);
      if (name) files.set(name, Math.max(0, Number(f.size) || 0));
    }
    if (!files.size) throw new Error('Es wurde nichts angekündigt.');
    this.clearTakes();
    for (const d of ['pack', 'web']) {
      fs.rmSync(path.join(this.dir, d), { recursive: true, force: true });
      fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    }
    this.plan = {
      files,
      done: new Set(),
      order: (Array.isArray(plan.order) ? plan.order : []).map(String),
      useAsIs: (Array.isArray(plan.useAsIs) ? plan.useAsIs : []).map(String),
      durations: Object.fromEntries((Array.isArray(plan.durations) ? plan.durations : [])
        .map((d) => [String(d?.id), Number(d?.duration) || 0])),
      title: String(plan.title || '').slice(0, 120),
      folder: safeName(plan.folder) || null,
      complete: false,
      ready: 0,
    };
    this.pack = null;
    this.clips = new Map();
    this.claims.clear();
    this.ready.clear();
    this.version++;
    this.video = { status: 'none', pct: 0, file: null, mime: null, duration: 0, height: 0, codec: null, h264: false };
    this.packStatus = { status: 'uploading', error: null, note: null };
    this.rescan();
  }

  /** Eine Datei ist angekommen. Erst wenn sie vollständig ist, zählt sie (nur beim fortlaufenden Hochladen). */
  fileArrived(name, bytes) {
    const p = this.plan;
    if (!p || p.done.has(name)) return;
    const want = p.files.get(name);
    if (want === undefined || bytes < want) return;
    p.done.add(name);
    // Das Video zuerst umwandeln: das dauert am längsten und läuft neben dem Rest des Uploads
    if (this.pack?.video === name || (!this.pack && /^dub_video\./i.test(name))) {
      this.rescan();
      if (this.pack?.video === name) this.prepareVideo().catch((e) => console.warn('Video:', e.message));
      return;
    }
    this.scheduleRescan();
  }

  /** Höchstens ein paar Mal pro Sekunde neu einlesen, sonst kostet jede kleine Datei einen Durchlauf. */
  scheduleRescan() {
    if (this.rescanTimer) {
      this.rescanPending = true;
      return;
    }
    this.rescan();
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      if (this.rescanPending) {
        this.rescanPending = false;
        this.scheduleRescan();
      }
    }, 300);
  }

  /** Pack aus dem, was schon da ist, neu aufbauen. Zeilen ohne Dateien bleiben „kommt noch“. */
  rescan() {
    const p = this.plan;
    if (!p) return;
    let pack;
    try {
      pack = readPack(this.packDir(), { expect: [...p.files.keys()], done: p.done, durations: p.durations });
    } catch (e) {
      return console.warn('Pack lesen:', e.message);
    }
    if (!pack.clips.length) return;
    pack.title = pack.title || p.title || 'Pack';
    pack.folder = p.folder;
    this.pack = pack;
    this.clips = new Map(pack.clips.map((c) => [c.id, c]));
    const known = p.order.filter((id) => this.clips.has(id));
    this.orderMode = 'game';
    this.order = known.concat(pack.clips.map((c) => c.id).filter((id) => !known.includes(id)));
    this.useAsIs = new Set(p.useAsIs.filter((id) => this.clips.has(id)));
    for (const id of this.order) if (!known.includes(id)) this.useAsIs.add(id);
    const ready = this.performed().filter((id) => this.clips.get(id).have).length;
    this.packStatus = { status: 'ready', error: null, note: null };
    if (!p.complete) this.packStatus.loading = { have: ready, need: this.performed().length };
    if (ready !== p.ready) {
      p.ready = ready;
      this.orderVersion++;
    }
    // Auf eine Zeile gewartet, die jetzt da ist? Dann geht es weiter.
    if (this.waitClip && this.clipReady(this.waitClip)) {
      this.waitClip = null;
      this.advance();
    }
    this.onChange();
  }

  /** Sind die Dateien dieser Zeile da? Ohne fortlaufendes Hochladen immer ja. */
  clipReady(id) {
    if (!this.plan || this.plan.complete) return true;
    return !!this.clips.get(id)?.have;
  }

  /** Das Spiel hat alles hochgeladen. */
  finishStream(opts = {}) {
    if (!this.plan) throw new Error('Es läuft kein fortlaufender Upload.');
    if (Array.isArray(opts.order) && opts.order.length) this.plan.order = opts.order.map(String);
    if (Array.isArray(opts.useAsIs)) this.plan.useAsIs = opts.useAsIs.map(String);
    for (const f of this.plan.files.keys()) this.plan.done.add(f);
    this.plan.complete = true;
    this.plan.ready = -1;
    this.rescan();
    this.waitClip = null;
    this.advance();
    if (this.pack?.video && this.video.status === 'none') this.prepareVideo().catch((e) => console.warn('Video:', e.message));
    this.onChange();
  }

  /** Hochgeladenes Pack übernehmen. opts: {order, useAsIs, orderMode} (vom Spiel: dessen Reihenfolge), reuse: vorhandenes Pack behalten */
  async commit(opts = {}) {
    if (this.plan) return this.finishStream(opts);
    if (opts.reuse) return this.reuse(opts);
    const staging = this.stagingDir();
    if (!fs.existsSync(staging)) throw new Error('Es wurde nichts hochgeladen.');
    this.packStatus = { status: 'processing', error: null, note: null };
    this.onChange();
    let pack;
    try {
      pack = readPack(staging);
    } catch (e) {
      this.packStatus = { status: 'error', error: 'Das Pack konnte nicht gelesen werden.', note: null };
      throw e;
    }
    if (!pack.clips.length) {
      this.packStatus = { status: 'error', error: 'In diesem Pack sind keine Zeilen.', note: null };
      throw new Error(this.packStatus.error);
    }
    if (!pack.video) {
      this.packStatus = { status: 'error', error: 'In diesem Pack fehlt das Video (dub_video.ogv).', note: null };
      throw new Error(this.packStatus.error);
    }
    // Altes Pack weg, neues an seine Stelle
    const dest = this.packDir();
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    fs.rmSync(path.join(this.dir, 'web'), { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, 'web'), { recursive: true });
    this.clearTakes();
    this.pack = pack;
    this.pack.title = pack.title || String(opts.title || '').trim() || 'Pack';
    this.pack.folder = safeName(opts.folder) || null;
    this.clips = new Map(pack.clips.map((c) => [c.id, c]));
    for (const d of Array.isArray(opts.durations) ? opts.durations : []) {
      const c = this.clips.get(String(d.id));
      if (c && !c.duration && Number(d.duration) > 0) c.duration = Number(d.duration);
    }
    this.claims.clear();
    this.ready.clear();
    this.version++;
    if (Array.isArray(opts.order) && opts.order.length) {
      this.orderMode = 'game';
      const known = opts.order.map(String).filter((id) => this.clips.has(id));
      this.order = known.concat(pack.clips.map((c) => c.id).filter((id) => !known.includes(id)));
      this.useAsIs = new Set((Array.isArray(opts.useAsIs) ? opts.useAsIs : []).map(String));
      for (const id of this.order) if (!known.includes(id)) this.useAsIs.add(id);
    } else {
      if (opts.orderMode) this.orderMode = String(opts.orderMode);
      this.useAsIs = new Set();
      this.reorder();
    }
    this.packStatus = { status: 'ready', error: null, note: null };
    countStat('packs');
    observeStat('pack_mb', folderBytes(dest) / MB);
    observeStat('pack_lines', pack.clips.length);
    this.prepareVideo().catch((e) => console.warn('Video:', e.message));
    this.onChange();
  }

  /** Gleiches Pack noch einmal (z. B. neue Runde im Spiel): nur Reihenfolge und übernommene Zeilen neu, Dateien bleiben. */
  reuse(opts) {
    if (!this.pack || this.packStatus.status !== 'ready') throw new Error('Es ist noch kein Pack da.');
    if (this.phase !== 'hub') throw new Error('Das Pack kann nur in der Lobby gewechselt werden.');
    this.clearTakes();
    const known = (Array.isArray(opts.order) ? opts.order : []).map(String).filter((id) => this.clips.has(id));
    if (known.length) {
      this.orderMode = 'game';
      this.order = known.concat(this.pack.clips.map((c) => c.id).filter((id) => !known.includes(id)));
      this.useAsIs = new Set((Array.isArray(opts.useAsIs) ? opts.useAsIs : []).map(String));
      for (const id of this.order) if (!known.includes(id)) this.useAsIs.add(id);
    }
    this.orderVersion++;
    this.onChange();
  }

  reorder() {
    if (!this.pack) return;
    const mode = ['chrono', 'file', 'character', 'random'].includes(this.orderMode) ? this.orderMode : 'chrono';
    this.order = orderClips(this.pack.clips, mode);
  }

  /** Video für Browser bereitstellen: abspielbar lassen oder mit ffmpeg zu MP4 (H.264) umwandeln. */
  async prepareVideo() {
    const version = this.version;
    const src = path.join(this.packDir(), this.pack.video);
    const e = extOf(src);
    this.video = { status: 'checking', pct: 0, file: null, mime: null, duration: 0, height: 0, codec: null, h264: false };
    this.onChange();
    const info = findFfmpeg() ? await probe(src) : null;
    if (version !== this.version) return;
    this.video.duration = info?.duration || 0;
    if (this.video.duration) observeStat('video_min', this.video.duration / 60);
    this.video.height = info?.video?.height || 0;
    this.video.codec = info?.video?.codec || null;
    const codec = this.video.codec;
    const playable = (['mp4', 'm4v', 'mov'].includes(e) && codec === 'h264') || (e === 'webm' && ['vp8', 'vp9', 'av1'].includes(codec));
    if (playable) {
      Object.assign(this.video, { status: 'ready', file: src, mime: VIDEO_MIME[e] || 'video/mp4', h264: codec === 'h264' });
      return this.onChange();
    }
    const tooBig = this.video.duration > MAX_VIDEO_S || storageLeft(dataDirOf(this.room)) < this.video.duration * 400_000;
    if (!findFfmpeg() || tooBig) {
      Object.assign(this.video, { status: 'original', file: src, mime: VIDEO_MIME[e] || 'video/ogg' });
      return this.onChange();
    }
    const out = path.join(this.dir, 'web', 'video.mp4');
    this.video.status = 'converting';
    this.onChange();
    let last = 0;
    try {
      await ffmpeg(['-i', src, '-map', '0:v:0', '-an', '-vf', "scale=-2:'trunc(min(720,ih)/2)*2',format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-movflags', '+faststart', out], {
        duration: this.video.duration || 0,
        timeoutMs: 30 * 60 * 1000,
        key: 'video:' + out,
        onProgress: (p) => {
          this.video.pct = p;
          if (p - last > 0.05) { last = p; this.onChange(); }
        },
      });
      if (version !== this.version) return;
      Object.assign(this.video, { status: 'ready', pct: 1, file: out, mime: 'video/mp4', h264: true });
    } catch (err) {
      if (version !== this.version) return;
      console.warn('Video-Umwandlung fehlgeschlagen:', err.message);
      Object.assign(this.video, { status: 'original', file: src, mime: VIDEO_MIME[e] || 'video/ogg' });
    }
    this.onChange();
  }

  characters() {
    const out = [];
    for (const id of this.order) {
      if (this.useAsIs.has(id)) continue;
      for (const c of this.clips.get(id)?.chars || []) if (!out.includes(c)) out.push(c);
    }
    return out;
  }

  performed() {
    return this.order.filter((id) => this.clips.has(id) && !this.useAsIs.has(id));
  }

  /** Meta fürs Laden im Browser (ohne Zugangsschlüssel, den hängt der Browser an). */
  packJson() {
    if (!this.pack) return { version: this.version, orderVersion: this.orderVersion, pack: null };
    const base = `/api/rooms/${this.room.code}/dub`;
    const f = (name) => (name ? `${base}/file/${encodeURIComponent(name)}` : null);
    return {
      version: this.version,
      orderVersion: this.orderVersion,
      pack: {
        title: this.pack.title, subtitle: this.pack.subtitle, authors: this.pack.authors, readme: this.pack.readme,
        icon: f(this.pack.icon), backing: f(this.pack.backing),
        clips: this.order.map((id) => {
          const c = this.clips.get(id);
          return { id, caption: c.caption, chars: c.chars, times: c.times, duration: c.duration, image: f(c.image), audio: f(c.audio),
            useAsIs: this.useAsIs.has(id), ready: this.clipReady(id) };
        }),
      },
    };
  }

  /* ---------- Spieler ---------- */

  participants() {
    return this.room.participants().filter((p) => !this.spectators.has(p.id) && (p.kind === 'local' || p.connected));
  }

  nameOf(pid) {
    const p = this.room.players.get(pid);
    if (p) return p.name;
    for (const t of this.takes.values()) if (t.playerId === pid) return t.name;
    return '?';
  }

  toggleClaim(character, pid) {
    if (this.phase !== 'hub' || !this.characters().includes(character)) return false;
    const owner = this.claims.get(character);
    if (owner === pid) this.claims.delete(character);
    else if (!owner || !this.room.players.get(owner)) this.claims.set(character, pid);
    else return false;
    return true;
  }

  /** Figur nehmen (on = true) oder freigeben (on = false). Doppelt geschickt ändert nichts. */
  claimFor(character, pid, on) {
    if (this.phase !== 'hub' || !this.characters().includes(character)) return false;
    const owner = this.claims.get(character);
    if (on) {
      if (owner && owner !== pid && this.room.players.get(owner)) return false;
      this.claims.set(character, pid);
    } else if (owner === pid) this.claims.delete(character);
    return true;
  }

  claim(character, pid, on) {
    return typeof on === 'boolean' ? this.claimFor(character, pid, on) : this.toggleClaim(character, pid);
  }

  assign(character, pid) {
    if (this.phase !== 'hub' || !this.characters().includes(character)) return false;
    if (!pid) this.claims.delete(character);
    else if (this.room.players.has(pid)) this.claims.set(character, pid);
    else return false;
    return true;
  }

  onPlayerRemoved(pid) {
    if (this.offer && (this.offer.from === pid || this.offer.to === pid)) this.dropOffer();
    for (const [c, owner] of this.claims) if (owner === pid) this.claims.delete(c);
    this.spectators.delete(pid);
    this.ready.delete(pid);
    if (this.phase === 'playing' || this.phase === 'paused') {
      // Offene Zeilen neu verteilen (wie im Steam-Mod: ohne Besitzer gilt „der Reihe nach“)
      const cur = this.turns[this.turnIndex];
      if (cur && cur.recorders.includes(pid) && !this.hasTake(cur.clipId, pid)) this.skipped.add(key(cur.clipId, pid));
      this.buildTurns(this.turnIndex + 1);
      if (this.pause?.playerId === pid) this.endPause();
      this.advance();
    }
  }

  onConnect(pid) {
    if (this.pause?.playerId === pid) {
      this.endPause();
      this.onChange();
    }
    // Mitten in der Runde dazugekommen: ab der nächsten Zeile mitspielen.
    // Wer schon Zeilen in dieser Runde hat, behält sie.
    if ((this.phase === 'playing' || this.phase === 'paused') && !this.spectators.has(pid)
        && !this.turns.some((t) => t.recorders.includes(pid))) {
      this.buildTurns(this.turnIndex + 1);
      this.onChange();
    }
  }

  onDisconnect(pid) {
    if (this.phase !== 'playing') return;
    const t = this.turns[this.turnIndex];
    if (!t || !t.recorders.includes(pid) || this.hasTake(t.clipId, pid) || this.skipped.has(key(t.clipId, pid))) return;
    this.phase = 'paused';
    this.pause = { playerId: pid, until: Date.now() + PAUSE_GRACE_MS };
    clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      if (this.pause?.playerId !== pid) return;
      if (this.room.players.get(pid)?.connected) return this.endPause();
      this.skipped.add(key(t.clipId, pid));
      this.endPause();
      // Wie im Steam-Mod: seine weiteren Zeilen übernehmen die, die noch da sind
      this.buildTurns(this.turnIndex + 1);
      this.advance();
      this.onChange();
    }, PAUSE_GRACE_MS);
    this.onChange();
  }

  endPause() {
    clearTimeout(this.pauseTimer);
    this.pause = null;
    if (this.phase === 'paused') this.phase = 'playing';
  }

  /* ---------- Runden ---------- */

  buildTurns(from = 0) {
    const parts = this.participants();
    const perf = this.performed();
    const out = this.turns.slice(0, from);
    for (let i = from; i < perf.length; i++) {
      const clip = this.clips.get(perf[i]);
      let recs = [];
      if (!this.chrono) {
        for (const ch of clip.chars) {
          const o = this.claims.get(ch);
          if (o && parts.some((p) => p.id === o) && !recs.includes(o)) recs.push(o);
        }
      }
      if (!recs.length && parts.length) recs = [parts[i % parts.length].id];
      out.push({ clipId: perf[i], index: i, recorders: recs });
    }
    this.turns = out;
  }

  hasTake(clipId, pid) { return this.takes.has(key(clipId, pid)); }

  turnDone(t) {
    return t.recorders.every((pid) => this.hasTake(t.clipId, pid) || this.skipped.has(key(t.clipId, pid)));
  }

  takesFor(clipId) {
    return [...this.takes.values()].filter((x) => x.clipId === clipId);
  }

  canStart() {
    if (this.phase !== 'hub') return { ok: false, reason: 'not_in_hub' };
    if (!this.pack || this.packStatus.status !== 'ready') return { ok: false, reason: 'no_pack' };
    if (!this.performed().length) return { ok: false, reason: 'no_lines' };
    // Fortlaufendes Hochladen: los geht es, sobald das Video und die erste Zeile da sind
    if (this.plan && !this.plan.complete) {
      if (!['ready', 'original'].includes(this.video.status)) return { ok: false, reason: 'video_loading' };
      if (!this.clipReady(this.performed()[0])) return { ok: false, reason: 'pack_loading' };
    }
    const parts = this.participants();
    if (!parts.length) return { ok: false, reason: 'no_players' };
    const waiting = parts.filter((p) => p.kind === 'phone' && !this.isReady(p.id)).map((p) => p.id);
    if (waiting.length) return { ok: false, reason: 'loading', waiting };
    return { ok: true };
  }

  isReady(pid) {
    const r = this.ready.get(pid);
    return !!r && r.version === this.version && r.have >= r.need && r.need > 0;
  }

  start(force = false) {
    const check = this.canStart();
    if (!check.ok && !(force && ['loading'].includes(check.reason))) return check;
    const parts = this.participants();
    if (!this.chrono && parts.length) {
      // Wie im Steam-Mod: freie Figuren bekommt zufällig jemand
      for (const c of this.characters()) {
        const o = this.claims.get(c);
        if (!o || !parts.some((p) => p.id === o)) this.claims.set(c, parts[Math.floor(Math.random() * parts.length)].id);
      }
    }
    this.turns = [];
    this.buildTurns(0);
    // Weitermachen: Zeilen mit vorhandenen Aufnahmen gelten als fertig
    for (const t of this.turns) {
      const owners = this.takesFor(t.clipId).map((x) => x.playerId);
      if (owners.length) t.recorders = owners;
    }
    this.skipped.clear();
    this.gameDone = false;
    this.phase = 'playing';
    this.turnIndex = 0;
    this.watch = null;
    this.activity.clear();
    this.advance();
    return { ok: true };
  }

  advance() {
    if (this.phase !== 'playing' && this.phase !== 'paused') return;
    const before = this.turnIndex;
    while (this.turnIndex < this.turns.length && this.turnDone(this.turns[this.turnIndex])) this.turnIndex++;
    if (this.turnIndex >= this.turns.length) {
      this.endPause();
      this.phase = 'results';
      this.endRound();
      this.onEvent({ type: 'dub.results' });
      return;
    }
    if (before !== this.turnIndex) this.activity.clear();
    const t = this.turns[this.turnIndex];
    // Die Zeile ist noch unterwegs: warten. rescan() macht weiter, sobald sie da ist.
    if (!this.clipReady(t.clipId)) {
      this.waitClip = t.clipId;
      return;
    }
    this.waitClip = null;
    if (this.offer && this.offer.clipId !== t.clipId) this.dropOffer();
    // Wer dran ist und gerade nicht verbunden ist: warten (Pause)
    for (const pid of t.recorders) {
      const p = this.room.players.get(pid);
      if (p?.kind === 'phone' && !p.connected && !this.hasTake(t.clipId, pid) && !this.skipped.has(key(t.clipId, pid))) {
        this.phase = 'playing';
        this.onDisconnect(pid);
        break;
      }
    }
  }

  /* ---------- Zeile abgeben ---------- */

  /** Wer diese Zeile noch sprechen muss. */
  openRecorders(t) {
    if (!t) return [];
    return t.recorders.filter((pid) => !this.hasTake(t.clipId, pid) && !this.skipped.has(key(t.clipId, pid)));
  }

  /** Die laufende Zeile jemand anderem anbieten. Angenommen wird sie erst von der anderen Person.
   *  byPid: wer anbietet (null = das Spiel am PC), dann gibt sie die erste offene Person ab. */
  offerLine(byPid, toPid) {
    const t = this.turns[this.turnIndex];
    if (!t || (this.phase !== 'playing' && this.phase !== 'paused')) return 'Gerade läuft keine Zeile.';
    const open = this.openRecorders(t);
    if (!open.length) return 'Diese Zeile ist schon durch.';
    const from = open.includes(byPid) ? byPid : !byPid || this.isLeader(byPid) ? open[0] : null;
    if (!from) return 'Diese Zeile gehört dir nicht.';
    const to = this.room.players.get(String(toPid));
    // Annehmen geht am Handy und im Browser. Wer am PC spielt, kann Zeilen abgeben, aber keine annehmen.
    if (!to || to.kind !== 'phone' || !to.connected || to.left) return 'Diese Person ist gerade nicht da.';
    if (to.id === from) return 'Das ist dieselbe Person.';
    if (t.recorders.includes(to.id)) return 'Die Person hat diese Zeile schon.';
    if (this.spectators.has(to.id)) return 'Die Person schaut nur zu.';
    clearTimeout(this.offerTimer);
    this.offer = { clipId: t.clipId, from, to: to.id, until: Date.now() + OFFER_MS };
    this.offerTimer = setTimeout(() => {
      if (!this.offer) return;
      this.offer = null;
      this.onChange();
    }, OFFER_MS);
    this.onEvent({ type: 'dub.offer', clipId: t.clipId, from, fromName: this.nameOf(from), to: to.id });
    return true;
  }

  /** Angebot annehmen (ok) oder ablehnen. */
  takeLine(pid, ok) {
    const o = this.offer;
    if (!o || o.to !== pid) return 'Dieses Angebot gibt es nicht mehr.';
    this.dropOffer();
    if (!ok) {
      this.onEvent({ type: 'dub.offer.no', to: pid, name: this.nameOf(pid), from: o.from });
      return true;
    }
    const t = this.turns[this.turnIndex];
    if (!t || t.clipId !== o.clipId) return 'Diese Zeile ist schon vorbei.';
    // Die Zeile wechselt: wer sie abgegeben hat, muss sie nicht mehr sprechen
    t.recorders = t.recorders.filter((x) => x !== o.from).concat(t.recorders.includes(pid) ? [] : [pid]);
    this.skipped.delete(key(t.clipId, pid));
    this.activity.delete(o.from);
    this.onEvent({ type: 'dub.offer.yes', clipId: t.clipId, from: o.from, to: pid, name: this.nameOf(pid) });
    this.advance();
    return true;
  }

  /** Angebot zurückziehen (auch von selbst, wenn die Zeile weiterzieht). */
  cancelOffer(byPid) {
    if (!this.offer) return true;
    if (byPid && byPid !== this.offer.from && !this.isLeader(byPid)) return 'Das Angebot ist nicht deins.';
    this.dropOffer();
    return true;
  }

  dropOffer() {
    clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.offer = null;
  }

  /** clipId: nur überspringen, wenn diese Zeile noch dran ist (doppelt geklickt überspringt sonst zwei). */
  skipCurrent(clipId = null) {
    const t = this.turns[this.turnIndex];
    if (!t || (this.phase !== 'playing' && this.phase !== 'paused')) return false;
    if (clipId && t.clipId !== clipId) return false;
    for (const pid of t.recorders) if (!this.hasTake(t.clipId, pid)) this.skipped.add(key(t.clipId, pid));
    this.endPause();
    this.advance();
    return true;
  }

  /** Für die Statistik: eine Dub-Runde ist vorbei (durchgespielt oder abgebrochen).
   *  Gemessen werden nur frisch gestartete Runden, „Weitermachen“ zählt zur laufenden. */
  endRound() {
    if (!this.startedAt) return;
    observeStat('dub_min', (Date.now() - this.startedAt) / 60_000);
    observeStat('dub_lines', this.takes.size);
    this.startedAt = null;
  }

  toHub() {
    this.dropOffer();
    this.endRound();
    this.endPause();
    this.phase = 'hub';
    this.turnIndex = -1;
    this.watch = null;
    this.activity.clear();
  }

  clearTakes() {
    this.toHub();
    fs.rmSync(path.join(this.dir, 'takes'), { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, 'takes'), { recursive: true });
    this.takes.clear();
    this.skipped.clear();
    this.gameScores.clear();
    this.gameDone = false;
    this.turns = [];
    this.exportJob = { status: 'idle', pct: 0, error: null, file: null, name: null };
  }

  /** Aufnahme annehmen. -> Fehlertext oder null */
  addTake(clipId, pid, buf, score) {
    if (this.phase !== 'playing' && this.phase !== 'paused') return 'Gerade wird nicht aufgenommen.';
    const t = this.turns[this.turnIndex];
    if (!t || t.clipId !== clipId || !t.recorders.includes(pid)) return 'Diese Zeile ist gerade nicht deine.';
    const info = wavInfo(buf);
    if (!info || info.tag !== 1 || ![8, 16].includes(info.bits)) return 'Die Aufnahme ist keine gültige WAV-Datei.';
    const idx = this.order.indexOf(clipId);
    const file = path.join(this.dir, 'takes', `take_${idx}_${String(pid).replace(/[^a-z0-9-]/gi, '')}.wav`);
    fs.writeFileSync(file, buf);
    this.skipped.delete(key(clipId, pid));
    countStat('takes');
    countStat('lines');
    countStat('take_mb', buf.length / MB);
    if (info.duration) observeStat('take_s', info.duration);
    this.takes.set(key(clipId, pid), { clipId, playerId: pid, name: this.nameOf(pid), file, at: Date.now(), score: score ?? null, duration: info.duration });
    this.activity.delete(pid);
    this.onEvent({ type: 'dub.take', clipId, playerId: pid, url: `/api/rooms/${this.room.code}/dub/takes/${encodeURIComponent(clipId)}/${encodeURIComponent(pid)}` });
    this.advance();
    return null;
  }

  /* ---------- Gemeinsam anschauen ---------- */

  /** Raum aus dem Spiel: das Spiel ist noch mit der letzten Zeile beschäftigt (es spielt Web-Aufnahmen nacheinander ein). */
  waitGame() {
    return this.source === 'game' && this.phase === 'results' && !this.gameDone && this.room.hosts.size > 0;
  }

  startWatch() {
    this.watch = { id: rid(4), at: Date.now() + WATCH_LEAD_MS };
    this.onEvent({ type: 'dub.watch', id: this.watch.id, at: this.watch.at });
  }

  stopWatch() {
    this.watch = null;
    this.onEvent({ type: 'dub.watch.stop' });
  }

  /* ---------- Ansicht ---------- */

  view(forPid) {
    const t = this.turns[this.turnIndex] || null;
    const counts = {};
    for (const id of this.performed()) for (const c of this.clips.get(id).chars) counts[c] = (counts[c] || 0) + 1;
    const players = this.room.participants().map((p) => ({
      id: p.id,
      ready: p.kind === 'local' ? true : this.isReady(p.id),
      progress: this.ready.get(p.id)?.version === this.version ? { have: this.ready.get(p.id).have, need: this.ready.get(p.id).need } : null,
      spectator: this.spectators.has(p.id),
      activity: this.activity.get(p.id)?.what || null,
    }));
    const leader = this.leaderPid();
    const done = this.turns.filter((x) => this.turnDone(x)).length;
    return {
      source: this.source,
      version: this.version,
      orderVersion: this.orderVersion,
      phase: this.phase,
      leader,
      packStatus: this.packStatus,
      pack: this.pack ? {
        title: this.pack.title, authors: this.pack.authors, clipCount: this.clips.size, perfCount: this.performed().length,
        hasBacking: !!this.pack.backing,
      } : null,
      waitClip: this.waitClip,
      offer: this.offer ? { ...this.offer, fromName: this.nameOf(this.offer.from), toName: this.nameOf(this.offer.to) } : null,
      video: { status: this.video.status, pct: Math.round(this.video.pct * 100) / 100, duration: this.video.duration },
      orderMode: this.orderMode,
      chrono: this.chrono,
      characters: this.characters().map((c) => ({ name: c, claimedBy: this.claims.get(c) || null, lines: counts[c] || 0 })),
      players,
      canStart: this.canStart(),
      turn: t ? {
        index: this.turnIndex, clipId: t.clipId,
        recorders: t.recorders.map((pid) => ({ id: pid, name: this.nameOf(pid), done: this.hasTake(t.clipId, pid), skipped: this.skipped.has(key(t.clipId, pid)) })),
      } : null,
      turns: this.turns.map((x) => ({ clipId: x.clipId, recorders: x.recorders })),
      done,
      total: this.turns.length || this.performed().length,
      pause: this.pause ? { playerId: this.pause.playerId, name: this.nameOf(this.pause.playerId), until: this.pause.until } : null,
      watch: this.watch,
      chat: this.chat.slice(-30),
      takes: [...this.takes.values()].map((x) => ({ clipId: x.clipId, playerId: x.playerId, name: x.name, score: x.score, v: x.at })),
      gameScores: Object.fromEntries(this.gameScores),
      export: { status: this.exportJob.status, pct: Math.round(this.exportJob.pct * 100) / 100, error: this.exportJob.error, name: this.exportJob.name },
      ffmpeg: !!findFfmpeg(),
      waitGame: this.waitGame(),
      me: forPid ? {
        leader: leader === forPid, canUpload: this.canUpload(forPid), spectator: this.spectators.has(forPid),
        owner: this.leaderId === forPid,
      } : null,
    };
  }

  /* ---------- Export ---------- */

  async runExport() {
    if (!findFfmpeg()) throw new Error('Auf dem Server fehlt ffmpeg, deshalb geht der Video-Export hier nicht.');
    if (['queued', 'running'].includes(this.exportJob.status)) return;
    const job = { status: 'queued', pct: 0, error: null, file: null, name: `${slug(this.pack.title)} ${stamp()}.mp4` };
    this.exportJob = job;
    this.onChange();
    const work = path.join(this.dir, 'work');
    const tick = (p) => {
      const before = job.pct;
      job.pct = p;
      if (p - before > 0.04 || p >= 1) this.onChange();
    };
    try {
      job.status = 'running';
      const duration = this.video.duration || (await probe(path.join(this.packDir(), this.pack.video)))?.duration || 0;
      if (!duration) throw new Error('Die Länge des Videos ist unbekannt.');
      if (duration > MAX_VIDEO_S) throw new Error('Das Video ist für den Export zu lang.');
      const frames = Math.round(duration * SR);
      // Grob: Mischung und Hintergrund (16 Bit Stereo) plus fertiges Video
      const need = frames * 4 * (this.pack.backing ? 2 : 1) + duration * 1_000_000;
      if (storageLeft(dataDirOf(this.room)) < need) throw new Error('Der Server ist gerade voll. Versuch es später nochmal.');
      // 1. Originalclips, die gebraucht werden (übernommene Zeilen, fehlende Aufnahmen)
      const placements = [];
      const needOriginal = [];
      for (const id of this.order) {
        const c = this.clips.get(id);
        if (!c.times.length) continue;
        const takes = this.useAsIs.has(id) ? [] : this.takesFor(id);
        if (takes.length) placements.push({ times: c.times, pcm: mixTakes(takes.map((x) => x.file)) });
        else needOriginal.push(c);
      }
      tick(0.05);
      const originals = needOriginal.map((c) => ({ src: path.join(this.packDir(), c.audio), out: path.join(work, `orig_${this.order.indexOf(c.id)}.raw`) }));
      await decodeOriginals(originals);
      for (const [i, c] of needOriginal.entries()) {
        const raw = originals[i].out;
        if (fs.existsSync(raw)) placements.push({ times: c.times, pcm: readS16Mono(raw) });
      }
      tick(0.15);
      // 2. Hintergrund
      let backRaw = null;
      if (this.pack.backing) {
        backRaw = path.join(work, 'backing.raw');
        await ffmpeg(['-i', path.join(this.packDir(), this.pack.backing), '-f', 's16le', '-ac', '2', '-ar', String(SR), backRaw], { timeoutMs: 5 * 60 * 1000 });
      }
      tick(0.25);
      // 3. Mischen (wie Voicitool: alles zusammen, zu laut -> gesamt leiser auf 0,99)
      const mixFile = path.join(work, 'mix.wav');
      mixToWav(mixFile, frames, backRaw, placements);
      tick(0.35);
      // 4. Video + Ton
      const out = path.join(work, 'export.mp4');
      const source = path.join(this.packDir(), this.pack.video);
      // Umgewandeltes Browser-Video (bis 720p) übernehmen, wenn die Quelle nicht größer ist; sonst neu aus der Quelle (bis 1080p)
      const copyVideo = this.video.h264 && !!this.video.file && (this.video.file === source ? this.video.height <= 1080 : this.video.height <= 720);
      const vsrc = copyVideo ? this.video.file : source;
      const venc = copyVideo
        ? ['-c:v', 'copy']
        : ['-vf', "scale=-2:'trunc(min(1080,ih)/2)*2',format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
      await ffmpeg(['-i', vsrc, '-i', mixFile, '-map', '0:v:0', '-map', '1:a:0', ...venc,
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-t', duration.toFixed(3), '-movflags', '+faststart', out], {
        duration, timeoutMs: 30 * 60 * 1000, onProgress: (p) => tick(0.35 + 0.65 * p),
      });
      fs.rmSync(mixFile, { force: true });
      if (backRaw) fs.rmSync(backRaw, { force: true });
      job.file = out;
      job.status = 'done';
      countStat('exports');
      job.pct = 1;
    } catch (e) {
      job.status = 'error';
      countStat('export_fail');
      job.error = e.message.startsWith('ffmpeg') ? 'Der Export ist fehlgeschlagen.' : e.message;
      console.warn('Export fehlgeschlagen:', e.message);
    }
    this.onChange();
  }

  /** Aufnahmen als ZIP, so benannt wie das Spiel sie speichert (_dubrecord_<Zeile>.wav). */
  takesZip() {
    const work = path.join(this.dir, 'work');
    const folder = `${slug(this.pack.folder || this.pack.title)}/${stamp().replace(' ', 'T')}`;
    const files = [];
    for (const id of this.performed()) {
      const takes = this.takesFor(id);
      if (!takes.length) continue;
      let file = takes[0].file;
      if (takes.length > 1) {
        file = path.join(work, `mixed_${this.order.indexOf(id)}.wav`);
        writeWavMono(file, mixTakes(takes.map((x) => x.file)));
      }
      files.push({ name: `${folder}/_dubrecord_${id}.wav`, file });
    }
    if (!files.length) throw new Error('Es gibt noch keine Aufnahmen.');
    const out = path.join(work, 'aufnahmen.zip');
    writeZip(out, files);
    return { file: out, name: `${slug(this.pack.title)} ${stamp()}.zip` };
  }

  destroy() {
    this.endRound();
    clearTimeout(this.pauseTimer);
    clearTimeout(this.rescanTimer);
    clearTimeout(this.offerTimer);
  }
}

/* ---------------------------------------------------------------------
 * Ton: Aufnahmen lesen, mischen, WAV schreiben
 * ------------------------------------------------------------------- */

/** WAV (8/16 Bit, mono/stereo, beliebige Rate) -> Float32 mono mit 44,1 kHz. */
function readWavMono(file) {
  const buf = fs.readFileSync(file);
  const info = wavInfo(buf);
  if (!info) return new Float32Array(0);
  const bps = info.bits / 8;
  const n = info.frames;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < info.channels; c++) {
      const o = info.dataStart + (i * info.channels + c) * bps;
      v += info.bits === 16 ? buf.readInt16LE(o) / 32768 : (buf[o] - 128) / 128;
    }
    mono[i] = v / info.channels;
  }
  if (info.rate === SR) return mono;
  const outLen = Math.round((n * SR) / info.rate);
  const out = new Float32Array(outLen);
  const k = info.rate / SR;
  for (let i = 0; i < outLen; i++) {
    const x = i * k, a = Math.floor(x), f = x - a;
    out[i] = (mono[a] || 0) * (1 - f) + (mono[a + 1] || 0) * f;
  }
  return out;
}

function mixTakes(files) {
  const parts = files.map(readWavMono);
  const out = new Float32Array(Math.max(0, ...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

function readS16Mono(file) {
  const b = fs.readFileSync(file);
  const out = new Float32Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2) / 32768;
  return out;
}

function wavHeader(frames, channels) {
  const h = Buffer.alloc(44);
  const bytes = frames * channels * 2;
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

function writeWavMono(file, pcm) {
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const g = peak > 0.99 ? 0.99 / peak : 1;
  const body = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i] * g)) * 32767), i * 2);
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length, 1), body]));
}

/** Hintergrund (Rohdaten s16le stereo) plus Zeilen an ihren Zeitpunkten, in Stücken, zweimal durch (Spitze, dann schreiben). */
function mixToWav(out, frames, backRaw, placements) {
  const CH = SR; // 1 s je Stück
  const spots = [];
  for (const p of placements) for (const t of p.times) spots.push({ start: Math.round(t * SR), pcm: p.pcm });
  const fd = backRaw ? fs.openSync(backRaw, 'r') : null;
  const chunk = new Float32Array(CH * 2);
  const raw = Buffer.alloc(CH * 4);
  const fill = (from, len) => {
    chunk.fill(0, 0, len * 2);
    if (fd !== null) {
      const got = fs.readSync(fd, raw, 0, len * 4, from * 4);
      for (let i = 0; i < got >> 1; i++) chunk[i] = raw.readInt16LE(i * 2) / 32768;
    }
    for (const s of spots) {
      const a = Math.max(from, s.start), b = Math.min(from + len, s.start + s.pcm.length);
      for (let f = a; f < b; f++) {
        const v = s.pcm[f - s.start];
        chunk[(f - from) * 2] += v;
        chunk[(f - from) * 2 + 1] += v;
      }
    }
  };
  let peak = 0;
  for (let from = 0; from < frames; from += CH) {
    const len = Math.min(CH, frames - from);
    fill(from, len);
    for (let i = 0; i < len * 2; i++) peak = Math.max(peak, Math.abs(chunk[i]));
  }
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  const ofd = fs.openSync(out, 'w');
  try {
    fs.writeSync(ofd, wavHeader(frames, 2));
    const ob = Buffer.alloc(CH * 4);
    for (let from = 0; from < frames; from += CH) {
      const len = Math.min(CH, frames - from);
      fill(from, len);
      for (let i = 0; i < len * 2; i++) ob.writeInt16LE(Math.round(Math.max(-1, Math.min(1, chunk[i] * gain)) * 32767), i * 2);
      fs.writeSync(ofd, ob, 0, len * 4);
    }
  } finally {
    fs.closeSync(ofd);
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Originalclips mit einem ffmpeg-Aufruf je 30 Dateien zu Rohdaten (s16le mono 44,1 kHz). */
async function decodeOriginals(items) {
  for (let i = 0; i < items.length; i += 30) {
    const part = items.slice(i, i + 30);
    const args = [];
    part.forEach((c) => args.push('-i', c.src));
    part.forEach((c, k) => args.push('-map', `${k}:a:0`, '-f', 's16le', '-ac', '1', '-ar', String(SR), c.out));
    await ffmpeg(args, { timeoutMs: 5 * 60 * 1000 });
  }
}

/* ---------------------------------------------------------------------
 * HTTP und WebSocket
 * ------------------------------------------------------------------- */

/** Datei aus dem Upload in eine Datei schreiben, mit Größengrenze. offset > 0: anhängen (Upload in Stücken). */
function receive(req, dest, max, offset = 0) {
  return new Promise((resolve, reject) => {
    let bytes = offset;
    const ws = fs.createWriteStream(dest, offset ? { flags: 'r+', start: offset } : undefined);
    let failed = false;
    const fail = (e) => {
      if (failed) return;
      failed = true;
      req.unpipe(ws);
      ws.destroy();
      // Upload in Stücken: nur das kaputte Stück verwerfen, damit der nächste Versuch dort weitermachen kann
      if (offset) fs.truncate(dest, offset, () => {});
      else fs.rm(dest, { force: true }, () => {});
      reject(e);
    };
    req.on('data', (d) => {
      bytes += d.length;
      if (bytes > max) {
        const e = new Error('too_large');
        e.status = 413;
        fail(e);
        req.resume();
      }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('aborted')));
    ws.on('error', fail);
    ws.on('finish', () => !failed && resolve(bytes));
    req.pipe(ws);
  });
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > max) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseScore(raw) {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    const n = Number(d.score);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  } catch {
    return null;
  }
}

function attachment(res, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
}

/**
 * Dub an den Server anschließen. ctx: {getRoom, isHost, send, toHosts, toPhones, broadcastState}
 * -> {onHost(room, ws, msg), onPhone(room, player, msg), onConnect, onDisconnect, onRemoved}
 */
export function installDub(app, ctx) {
  const { getRoom, isHost, send, toHosts, toPhones, broadcastState } = ctx;

  const ensure = (room, source) => {
    if (!room.dub) {
      room.dub = new DubSession(room, source);
      room.dub.onChange = () => broadcastState(room);
      room.dub.onEvent = (ev) => {
        if (ev.type === 'dub.take' || ev.type === 'dub.results') return toHosts(room, ev);
        toHosts(room, ev);
        toPhones(room, ev);
      };
    }
    room.game = 'dub';
    if (source === 'game') room.dub.source = 'game';
    return room.dub;
  };

  /** Wer fragt? -> {room, host, player, leader} oder null (Antwort schon gesendet) */
  const auth = (req, res, { leader = false, upload = false } = {}) => {
    const room = getRoom(req, res);
    if (!room) return null;
    const host = isHost(room, req);
    const player = room.findByToken(req.query.t);
    if (!host && !player) { res.status(403).json({ error: 'forbidden' }); return null; }
    const d = room.dub;
    if (!d && !(upload && host)) { res.status(404).json({ error: 'no_dub' }); return null; }
    const isLead = host || (d && player && d.isLeader(player.id));
    if (leader && !isLead) { res.status(403).json({ error: 'not_leader' }); return null; }
    if (upload && !host && !(d && d.canUpload(player.id))) { res.status(403).json({ error: 'not_allowed' }); return null; }
    return { room, host, player, leader: isLead, dub: d || ensure(room, 'game') };
  };

  const r = express.Router();

  // Pack hochladen: beginnen, Dateien einzeln oder eine ZIP-Datei, übernehmen.
  // Das Spiel schickt beim Beginnen einen Plan mit (alle Dateien und die Reihenfolge) und darf
  // dann schon starten, während der Rest noch kommt.
  r.post('/:code/dub/pack/begin', express.json({ limit: '4mb' }), (req, res) => {
    const a = auth(req, res, { upload: true });
    if (!a) return;
    try {
      a.dub.beginUpload(a.host && req.body?.stream ? req.body : null);
      broadcastState(a.room);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  r.put('/:code/dub/pack/file', async (req, res) => {
    const a = auth(req, res, { upload: true });
    if (!a) return;
    const name = safeName(req.query.name);
    if (!name) return res.status(400).json({ error: 'bad_name' });
    const dir = a.dub.uploadDir();
    if (!fs.existsSync(dir)) return res.status(409).json({ error: 'not_started' });
    const file = path.join(dir, name);
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    // Stücke müssen lückenlos aneinander passen
    const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (offset && offset !== have) return res.status(409).json({ error: 'bad_offset', have });
    // Grenze für diese Datei: was vom Pack (alle Dateien zusammen) und vom Server noch übrig ist
    const budget = Math.min(MAX_PACK - (folderBytes(dir) - have), storageLeft(dataDirOf(a.room)));
    if (budget <= 0) return res.status(413).json({ error: 'too_large' });
    try {
      const bytes = await receive(req, file, have + budget, offset);
      storageAdd(bytes - have);
      a.dub.fileArrived(name, bytes);
      res.json({ ok: true, bytes });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.put('/:code/dub/pack/zip', async (req, res) => {
    const a = auth(req, res, { upload: true });
    if (!a) return;
    const d = a.dub;
    const zip = path.join(d.dir, 'work', 'upload.zip');
    if (!checkStorage(res, dataDirOf(a.room), MB)) return;
    try {
      d.beginUpload();
      broadcastState(a.room);
      const got = await receive(req, zip, Math.min(MAX_PACK, storageLeft(dataDirOf(a.room))));
      storageAdd(got);
      d.packStatus = { status: 'processing', error: null, note: 'unzip' };
      broadcastState(a.room);
      await extractPackZip(zip, d.stagingDir(), Math.min(MAX_PACK * 2, storageLeft(dataDirOf(a.room))));
      storageAdd(folderBytes(d.stagingDir()));
      fs.rmSync(zip, { force: true });
      await d.commit({ orderMode: req.query.order });
      res.json({ ok: true, version: d.version });
    } catch (e) {
      fs.rmSync(zip, { force: true });
      if (d.packStatus.status !== 'error') d.packStatus = { status: d.pack ? 'ready' : 'error', error: e.message === 'too_large' ? 'Das Pack ist zu groß.' : e.message, note: null };
      broadcastState(a.room);
      res.status(e.status || 400).json({ error: d.packStatus.error || e.message });
    }
  });

  r.post('/:code/dub/pack/commit', express.json({ limit: '2mb' }), async (req, res) => {
    const a = auth(req, res, { upload: true });
    if (!a) return;
    try {
      await a.dub.commit(req.body || {});
      res.json({ ok: true, version: a.dub.version });
    } catch (e) {
      broadcastState(a.room);
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/:code/dub/pack.json', (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    res.set('Cache-Control', 'no-store');
    res.json(a.dub.packJson());
  });

  // Dateien aus dem Pack (Bilder, Clips, Hintergrund). ?fmt=mp3 wandelt Ton für ältere iPhones um, ?fmt=wav für Tests.
  r.get('/:code/dub/file/:name', async (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    const name = safeName(req.params.name);
    const file = name && path.join(a.dub.packDir(), name);
    if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'private, max-age=86400');
    const fmt = String(req.query.fmt || '');
    if ((fmt === 'mp3' || fmt === 'wav') && findFfmpeg() && extOf(name) !== fmt) {
      const out = path.join(a.dub.dir, 'web', `${name}.${fmt}`);
      const conv = fmt === 'mp3' ? ['-ac', '2', '-b:a', '160k'] : ['-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le'];
      try {
        if (!fs.existsSync(out)) await ffmpeg(['-i', file, '-vn', ...conv, out], { key: out, timeoutMs: 3 * 60 * 1000 });
        return res.type(fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav').sendFile(out);
      } catch {
        return res.status(500).json({ error: 'convert_failed' });
      }
    }
    res.type(FILE_MIME[extOf(name)] || 'application/octet-stream').sendFile(file);
  });

  r.get('/:code/dub/video', (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    const v = a.dub.video;
    if (!v.file || !fs.existsSync(v.file)) return res.status(404).json({ error: 'video_not_ready' });
    res.set('Cache-Control', 'private, max-age=86400');
    res.type(v.mime || 'video/mp4').sendFile(v.file);
  });

  // Aufnahme einer Zeile: vom Browser (Token) oder vom Spiel für Spieler am PC (Host-Schlüssel, ?player=local-1)
  r.post('/:code/dub/takes/:clipId', async (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    const pid = a.host && req.query.player ? String(req.query.player) : a.player?.id;
    if (!pid) return res.status(400).json({ error: 'no_player' });
    if (!checkStorage(res, dataDirOf(a.room), MB)) return;
    try {
      const buf = await readBody(req, MAX_TAKE);
      const err = a.dub.addTake(String(req.params.clipId), pid, buf, parseScore(req.get('x-phone-score')));
      if (err) return res.status(409).json({ error: err });
      storageAdd(buf.length);
      broadcastState(a.room);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  r.get('/:code/dub/takes/:clipId/:playerId', (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    const t = a.dub.takes.get(key(String(req.params.clipId), String(req.params.playerId)));
    if (!t || !fs.existsSync(t.file)) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'private, max-age=3600');
    res.type('audio/wav').sendFile(t.file);
  });

  r.get('/:code/dub/export.mp4', (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    const j = a.dub.exportJob;
    if (j.status !== 'done' || !j.file || !fs.existsSync(j.file)) return res.status(404).json({ error: 'not_ready' });
    if (req.query.dl !== '0') attachment(res, j.name);
    res.type('video/mp4').sendFile(j.file);
  });

  r.get('/:code/dub/takes.zip', (req, res) => {
    const a = auth(req, res);
    if (!a) return;
    try {
      const z = a.dub.takesZip();
      countStat('zips');
      attachment(res, z.name);
      res.type('application/zip').sendFile(z.file);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.use('/api/rooms', r);

  /* ---------- Nachrichten ---------- */

  /** Befehle, die Spielleiter (Browser) und Spiel gleichermaßen geben dürfen. */
  function leaderAction(room, d, msg, from) {
    switch (msg.type) {
      case 'dub.settings':
        if (d.phase !== 'hub') return 'Das geht nur in der Lobby.';
        if (typeof msg.chrono === 'boolean') d.chrono = msg.chrono;
        if (msg.orderMode && d.source !== 'game' && ['chrono', 'file', 'character', 'random'].includes(msg.orderMode)) {
          d.orderMode = msg.orderMode;
          d.reorder();
          d.orderVersion++;
        }
        return true;
      case 'dub.assign':
        return d.assign(String(msg.character), msg.playerId ? String(msg.playerId) : null) || 'Zuweisen nicht möglich.';
      case 'dub.start': {
        const fresh = d.takes.size === 0;   // „Weitermachen“ zählt nicht als neue Runde
        const r = d.start(!!msg.force);
        if (r.ok && fresh) {
          countStat('dubs');
          d.startedAt = Date.now();
        }
        return r.ok ? true : 'start:' + r.reason;
      }
      case 'dub.skip':
        d.skipCurrent(msg.clipId ? String(msg.clipId) : null);
        return true;
      case 'dub.hub':
        d.toHub();
        toPhones(room, { type: 'dub.hub' });
        toHosts(room, { type: 'dub.hub' });
        return true;
      case 'dub.reset':
        d.clearTakes();
        return true;
      case 'dub.watch':
        if (d.phase !== 'results') return 'Anschauen geht erst, wenn alle Zeilen fertig sind.';
        if (from && d.waitGame()) return 'Das Spiel am PC ist mit der letzten Zeile noch nicht fertig.';
        d.startWatch();
        return true;
      case 'dub.watch.stop':
        d.stopWatch();
        return true;
      case 'dub.export':
        if (d.phase !== 'results') return 'Exportieren geht erst am Ende.';
        d.runExport().catch((e) => {
          d.exportJob = { status: 'error', pct: 0, error: e.message, file: null, name: null };
          broadcastState(room);
        });
        return true;
      case 'dub.kick': {
        const p = room.players.get(String(msg.playerId));
        if (p?.kind === 'phone' && p.id !== from) {
          send(p.ws, { type: 'kicked' });
          p.ws?.close(4001, 'kicked');
          room.removePlayer(p.id);
          d.onPlayerRemoved(p.id);
        }
        return true;
      }
      default:
        return null;
    }
  }

  function common(room, d, msg, ws, name, pid) {
    switch (msg.type) {
      case 'dub.time':
        send(ws, { type: 'dub.time', t: Number(msg.t) || 0, server: Date.now() });
        return 'nobroadcast';
      case 'dub.offer':
        return d.offerLine(pid, String(msg.to || ''));
      case 'dub.offer.take':
        return d.takeLine(pid, !!msg.ok);
      case 'dub.offer.cancel':
        return d.cancelOffer(pid);
      case 'dub.chat': {
        const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) return 'nobroadcast';
        d.chat.push({ name: String(name || '').slice(0, 24), pid: pid || null, text, at: Date.now() });
        if (d.chat.length > 80) d.chat.splice(0, d.chat.length - 80);
        return true;
      }
      default:
        return null;
    }
  }

  function reply(room, ws, result) {
    if (result === 'nobroadcast') return true;
    if (typeof result === 'string') send(ws, { type: 'error', code: 'dub', message: result });
    broadcastState(room);
    return true;
  }

  return {
    open: (room, source) => ensure(room, source),

    onHost(room, ws, msg) {
      if (!String(msg.type).startsWith('dub.')) return false;
      if (msg.type === 'dub.open') {
        ensure(room, msg.source === 'game' ? 'game' : 'browser');
        return reply(room, ws, true);
      }
      if (msg.type === 'dub.close') {
        if (room.dub) { room.dub.destroy(); room.dub = null; }
        room.game = 'show';
        return reply(room, ws, true);
      }
      const d = room.dub;
      if (!d) return reply(room, ws, 'Kein Dub-Raum.');
      if (msg.type === 'dub.done') {
        d.gameDone = true;
        return reply(room, ws, true);
      }
      if (msg.type === 'dub.scores') {
        for (const s of Array.isArray(msg.scores) ? msg.scores.slice(0, 2000) : []) {
          const v = Number(s.score);
          if (d.clips.has(String(s.clipId)) && Number.isFinite(v)) d.gameScores.set(String(s.clipId), Math.max(0, Math.min(100, v)));
        }
        return reply(room, ws, true);
      }
      if (msg.type === 'dub.claim') {
        // Spieler am PC claimt (Spiel meldet für ihn)
        const pid = String(msg.playerId || '');
        return reply(room, ws, room.players.has(pid) && d.claim(String(msg.character), pid, msg.on) ? true : 'Claimen nicht möglich.');
      }
      if (msg.type === 'dub.activity') {
        if (msg.playerId) d.activity.set(String(msg.playerId), { what: String(msg.what || '').slice(0, 20), at: Date.now() });
        return reply(room, ws, true);
      }
      const c = common(room, d, msg, ws, msg.name || 'PC', null);
      if (c !== null) return reply(room, ws, c);
      const l = leaderAction(room, d, msg, null);
      return reply(room, ws, l === null ? true : l);
    },

    onPhone(room, player, msg) {
      if (!String(msg.type).startsWith('dub.')) return false;
      const ws = player.ws;
      if (msg.type === 'dub.open') {
        // Raum wurde im Browser erstellt: wer den Host-Schlüssel hat, leitet
        if (msg.key !== room.hostKey) return reply(room, ws, 'Falscher Schlüssel.');
        const d = ensure(room, room.dub?.source || 'browser');
        d.leaderId = player.id;
        return reply(room, ws, true);
      }
      const d = room.dub;
      if (!d) return reply(room, ws, 'Kein Dub-Raum.');
      const c = common(room, d, msg, ws, player.name, player.id);
      if (c !== null) return reply(room, ws, c);
      switch (msg.type) {
        case 'dub.claim':
          return reply(room, ws, d.claim(String(msg.character), player.id, msg.on) ? true : 'Diese Figur hat schon jemand.');
        case 'dub.ready': {
          const have = Math.max(0, Number(msg.have) || 0), need = Math.max(0, Number(msg.need) || 0);
          const before = d.isReady(player.id);
          d.ready.set(player.id, { have, need, version: Number(msg.version) || 0 });
          // Nur bei Änderung von „bereit“ oder alle paar Dateien neu senden
          return reply(room, ws, before !== d.isReady(player.id) || have % 5 === 0 ? true : 'nobroadcast');
        }
        case 'dub.spectate':
          if (d.phase !== 'hub') return reply(room, ws, 'Das geht nur in der Lobby.');
          if (msg.on) d.spectators.add(player.id);
          else d.spectators.delete(player.id);
          return reply(room, ws, true);
        case 'dub.activity':
          d.activity.set(player.id, { what: String(msg.what || '').slice(0, 20), at: Date.now() });
          return reply(room, ws, true);
        default:
          if (!d.isLeader(player.id)) return reply(room, ws, 'Das darf nur die Spielleitung.');
          return reply(room, ws, leaderAction(room, d, msg, player.id) ?? true);
      }
    },

    onConnect(room, player) {
      room.dub?.onConnect(player.id);
    },

    onDisconnect(room, player) {
      room.dub?.onDisconnect(player.id);
    },

    onRemoved(room, pid) {
      room.dub?.onPlayerRemoved(pid);
    },
  };
}
