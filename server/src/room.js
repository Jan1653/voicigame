import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { watcherCount } from './stream.js';
import { observe } from './stats.js';
import { storageDrop } from './limits.js';

const rid = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

/**
 * Ein Raum = eine Spielrunde am Host-PC.
 *
 * Spielerarten:
 *   phone  Freund am Handy (lädt Clips runter, nimmt auf)
 *   local  Spieler direkt am PC (das Spiel kümmert sich selbst um ihn)
 *
 * Modi:
 *   claim   Jeder claimt Charaktere. Ein Clip geht an den, der seinen Charakter geclaimt hat.
 *           Ungeclaimte Clips haben playerId = null, das Spiel entscheidet dann selbst.
 *   chrono  Alle Clips der Reihe nach, die Spieler wechseln sich reihum ab.
 *
 * Preload:
 *   an   Start erst, wenn jedes Handy alle seine Clips geladen hat.
 *   aus  Start sofort. Handys laden ab dem Beitreten im Hintergrund, der nächste Clip zuerst.
 */
export class Room {
  constructor(code, dataDir) {
    this.code = code;
    this.hostKey = rid(16);
    this.dir = path.join(dataDir, code);
    fs.mkdirSync(path.join(this.dir, 'clips'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'rec'), { recursive: true });

    this.players = new Map();
    this.joinCounter = 0;
    this.claims = new Map(); // character -> playerId
    this.clips = []; // {id,title,character,order,duration,file,mime,size,available}
    this.settings = { mode: 'claim', preload: false };
    this.phase = 'lobby'; // lobby | playing | ended
    this.schedule = []; // [{index, clipId, playerId}]
    this.cursor = -1;
    this.turn = null; // {turnId,index,clipId,playerId,status}
    this.results = [];
    this.hosts = new Set();
    // Gameshow: alle nehmen denselben Clip auf, das Spiel bewertet und meldet Punkte zurück
    this.game = 'show'; // show | dub
    this.show = { round: null, status: '', scores: [], ranking: null };
    this.dub = null; // Dub-Modus, siehe dub.js
    this.createdAt = Date.now();
    this.phonesJoined = 0;   // wie viele Handys/Browser insgesamt da waren (für die Statistik)
    this.touch();
  }

  /* ---------- Gameshow ---------- */

  /** Neue Runde: ein Clip, eine Liste von Handys, die ihn aufnehmen sollen. */
  startShowRound({ index, total, clipId, seconds, countdown, leadIn, recorders }) {
    const phones = [...this.players.values()].filter((p) => p.kind === 'phone' && !p.left).map((p) => p.id);
    const wanted = Array.isArray(recorders) && recorders.length ? recorders.filter((id) => phones.includes(id)) : phones;
    if (this.phase !== 'playing') this.show = { round: null, status: '', scores: [], ranking: null };
    this.phase = 'playing';
    this.show.round = {
      roundId: rid(6),
      index: Math.max(0, Number(index) || 0),
      total: Math.max(1, Number(total) || 1),
      clipId: String(clipId),
      seconds: Math.min(60, Math.max(1, Number(seconds) || 5)),
      countdown: Math.min(5, Math.max(0, Math.round(Number(countdown ?? 3)))),
      leadIn: Math.min(2, Math.max(0, Number(leadIn) || 0)),
      recorders: wanted,
      got: {},
      at: Date.now(),
    };
    return this.show.round;
  }

  /** Aufnahme eines Handys zur laufenden Runde. -> false, wenn es gar nicht dran ist */
  acceptShowRecording(roundId, playerId, file, phoneScore) {
    const r = this.show.round;
    if (!r || r.roundId !== roundId || !r.recorders.includes(playerId)) return false;
    r.got[playerId] = { file, phoneScore: phoneScore || null, at: Date.now() };
    return true;
  }

  /** base: die schon gebaute gemeinsame Sicht wiederverwenden (siehe view). */
  showView(forPlayerId, base = null) {
    const r = this.show.round;
    const round = base ? base.round : r ? {
      roundId: r.roundId, index: r.index, total: r.total, clipId: r.clipId, seconds: r.seconds,
      countdown: r.countdown, leadIn: r.leadIn, recorders: r.recorders, done: Object.keys(r.got),
    } : null;
    const view = base ? { ...base }
      : { game: this.game, round, status: this.show.status, scores: this.show.scores, ranking: this.show.ranking };
    if (forPlayerId && round) view.mine = round.recorders.includes(forPlayerId) && !round.done.includes(forPlayerId);
    return view;
  }

  resetShow() {
    this.show = { round: null, status: '', scores: [], ranking: null };
  }

  touch() {
    this.lastActive = Date.now();
  }

  /* ---------- Spieler ---------- */

  addPhone(name) {
    const p = {
      id: 'p' + rid(4),
      token: rid(16),
      name: cleanName(name),
      kind: 'phone',
      slot: null,
      joinOrder: this.joinCounter++,
      ws: null,
      connected: false,
      left: false,
      cached: new Set(),
      joinedAt: Date.now(),
    };
    this.players.set(p.id, p);
    this.phonesJoined++;
    this.recompute();
    return p;
  }

  findByToken(token) {
    if (!token) return null;
    for (const p of this.players.values()) if (p.token === token && p.kind === 'phone') return p;
    return null;
  }

  setLocalPlayers(list) {
    const keep = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      const slot = Number(item.slot);
      if (!Number.isFinite(slot)) continue;
      const id = 'local-' + slot;
      keep.add(id);
      const existing = this.players.get(id);
      if (existing) existing.name = cleanName(item.name || `Spieler ${slot}`);
      else
        this.players.set(id, {
          id, token: null, name: cleanName(item.name || `Spieler ${slot}`), kind: 'local', slot,
          joinOrder: this.joinCounter++, ws: null, connected: true, left: false, cached: new Set(),
        });
    }
    for (const p of [...this.players.values()]) {
      if (p.kind === 'local' && !keep.has(p.id)) this.removePlayer(p.id);
    }
    this.recompute();
  }

  /** Für die Statistik: wie lange jemand im Raum war (nur die Dauer, kein Name). */
  countTime(p) {
    if (!p || p.kind !== 'phone' || p.counted) return;
    p.counted = true;
    observe('player_min', (Date.now() - (p.joinedAt || this.createdAt)) / 60_000);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.countTime(p);
    for (const [c, owner] of this.claims) if (owner === id) this.claims.delete(c);
    if (this.phase === 'playing' && this.schedule.some((e) => e.playerId === id)) {
      p.left = true; // bleibt für die Ergebnisliste erhalten
    } else {
      this.players.delete(id);
    }
    this.recompute();
  }

  participants() {
    return [...this.players.values()].filter((p) => !p.left).sort((a, b) => a.joinOrder - b.joinOrder);
  }

  /* ---------- Clips & Charaktere ---------- */

  setClips(list) {
    const old = new Map(this.clips.map((c) => [c.id, c]));
    this.clips = (Array.isArray(list) ? list : []).map((c, i) => {
      const id = String(c.id);
      const prev = old.get(id);
      return {
        id,
        title: String(c.title ?? id).slice(0, 120),
        character: String(c.character ?? 'Unbekannt').slice(0, 60),
        order: Number.isFinite(+c.order) ? +c.order : i,
        duration: Number.isFinite(+c.duration) ? +c.duration : 0,
        file: prev?.file ?? null,
        mime: prev?.mime ?? null,
        size: prev?.size ?? 0,
        available: prev?.available ?? false,
      };
    });
    const valid = new Set(this.characters());
    for (const c of [...this.claims.keys()]) if (!valid.has(c)) this.claims.delete(c);
    this.recompute();
  }

  clip(id) {
    return this.clips.find((c) => c.id === id) || null;
  }

  ensureClip(id) {
    let c = this.clip(id);
    if (!c) {
      c = { id, title: id, character: 'Unbekannt', order: this.clips.length, duration: 0, file: null, mime: null, size: 0, available: false };
      this.clips.push(c);
    }
    return c;
  }

  characters() {
    const seen = [];
    for (const c of [...this.clips].sort((a, b) => a.order - b.order)) if (!seen.includes(c.character)) seen.push(c.character);
    return seen;
  }

  /** Spieler (Handy oder lokal) claimt oder gibt frei. force = Host darf alles. */
  setClaim(character, playerId, { force = false } = {}) {
    if (!this.characters().includes(character)) return false;
    const owner = this.claims.get(character);
    if (!playerId) {
      this.claims.delete(character);
    } else {
      if (owner && owner !== playerId && !force) return false;
      if (!this.players.has(playerId)) return false;
      this.claims.set(character, playerId);
    }
    this.recompute();
    return true;
  }

  toggleClaim(character, playerId) {
    const owner = this.claims.get(character);
    if (owner === playerId) return this.setClaim(character, null, { force: true });
    if (owner) return false;
    return this.setClaim(character, playerId);
  }

  /* ---------- Zeitplan ---------- */

  recompute() {
    const ordered = [...this.clips].sort((a, b) => a.order - b.order);
    const fixedUntil = this.phase === 'playing' ? this.cursor + 1 : 0;
    const kept = this.schedule.slice(0, fixedUntil);
    const rest = [];

    if (this.settings.mode === 'chrono') {
      const parts = this.participants();
      let pos = 0;
      const last = kept[kept.length - 1];
      if (last) pos = Math.max(0, parts.findIndex((p) => p.id === last.playerId) + 1);
      for (let i = fixedUntil; i < ordered.length; i++) {
        const p = parts.length ? parts[(pos++) % parts.length] : null;
        rest.push({ index: i, clipId: ordered[i].id, playerId: p ? p.id : null });
      }
    } else {
      for (let i = fixedUntil; i < ordered.length; i++) {
        rest.push({ index: i, clipId: ordered[i].id, playerId: this.claims.get(ordered[i].character) ?? null });
      }
    }
    this.schedule = kept.concat(rest);
  }

  /** Clips, die ein Spieler noch braucht, in Spielreihenfolge. */
  queueFor(playerId) {
    const from = this.phase === 'playing' ? Math.max(0, this.cursor) : 0;
    const out = [];
    for (const e of this.schedule) {
      if (e.index < from || e.playerId !== playerId) continue;
      if (e.index === this.cursor && this.turn && this.turn.status === 'done') continue;
      out.push(e.clipId);
    }
    return out;
  }

  progressFor(p) {
    const need = this.queueFor(p.id);
    const have = need.filter((id) => p.cached.has(id)).length;
    return { have, need: need.length, ready: have === need.length };
  }

  canStart() {
    if (this.phase !== 'lobby') return { ok: false, reason: 'not_in_lobby' };
    if (!this.clips.length) return { ok: false, reason: 'no_clips' };
    if (this.clips.some((c) => !c.available)) return { ok: false, reason: 'clips_uploading' };
    if (!this.participants().length) return { ok: false, reason: 'no_players' };
    if (this.settings.preload) {
      const waiting = this.participants().filter((p) => p.kind === 'phone' && !this.progressFor(p).ready);
      if (waiting.length) return { ok: false, reason: 'preloading', waiting: waiting.map((p) => p.id) };
    }
    return { ok: true };
  }

  start() {
    this.phase = 'playing';
    this.cursor = -1;
    this.turn = null;
    this.results = [];
    this.schedule = [];
    this.recompute();
  }

  nextTurn() {
    if (this.phase !== 'playing') return null;
    this.cursor++;
    const entry = this.schedule[this.cursor];
    if (!entry) {
      this.phase = 'ended';
      this.turn = null;
      return null;
    }
    const p = entry.playerId ? this.players.get(entry.playerId) : null;
    let status = 'open';
    if (p?.kind === 'local') status = 'local';
    if (p?.kind === 'phone') status = p.cached.has(entry.clipId) ? 'ready' : 'loading';
    this.turn = { turnId: rid(6), index: entry.index, clipId: entry.clipId, playerId: entry.playerId, status };
    return this.turn;
  }

  backToLobby() {
    this.phase = 'lobby';
    this.cursor = -1;
    this.turn = null;
    this.results = [];
    this.resetShow();
    this.recompute();
  }

  /* ---------- Ansichten ---------- */

  /**
   * Zustand für den Host (ohne forPlayerId) oder für ein Handy.
   * Fast alles ist für alle gleich, nur „me“, „show.mine“ und „dub.me“ nicht. Beim Rundruf wird
   * die gemeinsame Sicht deshalb einmal gebaut und hier als base wieder hereingereicht: das spart
   * bei vielen Räumen und Spielern den Großteil der Arbeit.
   */
  view(forPlayerId = null, base = null) {
    if (base) {
      const p = this.players.get(forPlayerId);
      return {
        ...base,
        show: this.showView(forPlayerId, base.show),
        dub: this.dub ? this.dub.view(forPlayerId, base.dub) : null,
        me: p ? { id: p.id, name: p.name, queue: this.queueFor(p.id) } : null,
      };
    }
    const players = [...this.players.values()]
      .filter((p) => !p.left)
      .sort((a, b) => a.joinOrder - b.joinOrder)
      .map((p) => ({
        id: p.id, name: p.name, kind: p.kind, slot: p.slot, connected: p.connected,
        game: p.client === 'game',   // tritt aus dem eigenen Spiel mit Mod bei
        progress: p.kind === 'phone' ? this.progressFor(p) : null,
      }));
    const counts = {};
    for (const c of this.clips) counts[c.character] = (counts[c.character] || 0) + 1;
    const view = {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      players,
      characters: this.characters().map((c) => ({ name: c, claimedBy: this.claims.get(c) ?? null, clipCount: counts[c] })),
      clips: [...this.clips]
        .sort((a, b) => a.order - b.order)
        .map(({ id, title, character, order, duration, size, available }) => ({ id, title, character, order, duration, size, available })),
      schedule: this.schedule,
      cursor: this.cursor,
      turn: this.turn,
      results: this.results.slice(-50),
      canStart: this.canStart(),
      show: this.showView(forPlayerId),
      watchers: watcherCount(this),
      hostOnline: this.hosts.size > 0,
      closed: !!this.closed,
      game: this.game,
      dub: this.dub ? this.dub.view(forPlayerId) : null,
    };
    if (forPlayerId) {
      const p = this.players.get(forPlayerId);
      view.me = p ? { id: p.id, name: p.name, queue: this.queueFor(p.id) } : null;
    }
    return view;
  }

  /** Für die Statistik: Raum ist vorbei (auch beim Beenden des Servers, dann ohne Aufräumen). */
  recordLife() {
    if (this.recorded) return;
    this.recorded = true;
    for (const p of this.players.values()) this.countTime(p);
    observe('room_min', (Date.now() - this.createdAt) / 60_000);
    observe('room_players', this.phonesJoined);
  }

  destroy() {
    this.recordLife();
    try {
      storageDrop(this.dir);   // vor dem Löschen zählen, danach ist nichts mehr da
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {}
  }
}

function cleanName(n) {
  const s = String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return s || 'Spieler';
}
