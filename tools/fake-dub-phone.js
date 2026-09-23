// Simuliertes Handy für den Dub-Modus (nur Tests).
//   node tools/fake-dub-phone.js <Raumcode | Datei mit Raumcode | neu> [Name] [modus]
// modus:  echo  = schickt den Original-Clip als Aufnahme (perfekt nachgesprochen)
//         still = schickt Stille
//         spaet = wie echo, aber erst nach 15 s
//         weg   = trennt die Verbindung, sobald es dran ist (Pause und Überspringen testen)
// Umgebung:
//   SERVER   Adresse des Servers (Standard http://localhost:8080)
//   PACK     nur bei „neu“: Pack-Ordner oder ZIP-Datei, die hochgeladen wird
//   CLAIM    Figuren, die geclaimt werden: "Brian,Guy A", "alle" oder leer
//   LEAD=1   leitet: startet, wenn PLAYERS Spieler bereit sind; am Ende anschauen, exportieren, herunterladen
//   PLAYERS  so viele Spieler (mit sich selbst) abwarten, bevor gestartet wird (Standard 1)
//   CHRONO=1 „der Reihe nach“ statt Figuren
//   WAVES    bei LEAD: Wellenformen der Mitspieler (all | host | off)
//   OUT      Ordner für Export und ZIP (bei LEAD)
//   ROUNDS   so viele Runden mitspielen, bevor es sich verabschiedet (Standard 1)
//   LATE_CLIP  nur diese Zeilen (Komma) verspätet schicken, LATE_S Sekunden (Standard 15)
//   WATCH_EARLY=1  als Spielleitung „Anschauen“ schicken, sobald der Server fertig meldet (Spiel noch nicht)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

const [, , codeArg = '', name = 'Dub-Test', mode = 'echo'] = process.argv;
const SERVER = (process.env.SERVER || 'http://localhost:8080').replace(/\/$/, '');
const LEAD = process.env.LEAD === '1';
const PLAYERS = Number(process.env.PLAYERS) || 1;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), `[${name}]`, ...a);

let code = '';
let token = '';
let hostKey = '';
let me = '';
let st = null;
let packVersion = -1;
let tries = 0;
let pack = null;
let claimed = false;
let sentFor = new Set();
let watched = false;
let exporting = false;
let finished = false;
let pauseLogged = null;
let lastPhase = '';
let rounds = 0;
let waitLogged = null;
let startTimer = null;

async function roomCode() {
  if (codeArg === 'neu') {
    const r = await (await fetch(`${SERVER}/api/rooms`, { method: 'POST' })).json();
    hostKey = r.hostKey;
    log('Raum erstellt', r.code);
    if (process.env.ROOM_FILE) fs.writeFileSync(process.env.ROOM_FILE, r.code);
    return r.code;
  }
  if (/^[A-Z]{4}$/.test(codeArg)) return codeArg;
  for (let i = 0; i < 480; i++) {
    try {
      const c = fs.readFileSync(codeArg, 'utf8').trim();
      if (/^[A-Z]{4}$/.test(c)) return c;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Kein Raumcode gefunden');
}

const q = () => `t=${token}`;
const wsSend = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

async function uploadPack() {
  const src = process.env.PACK;
  if (!src) return log('FEHLER: PACK fehlt');
  const t0 = Date.now();
  if (src.toLowerCase().endsWith('.zip')) {
    const body = fs.readFileSync(src);
    const r = await fetch(`${SERVER}/api/rooms/${code}/dub/pack/zip?${q()}`, { method: 'PUT', body });
    log('ZIP hochgeladen:', r.status, JSON.stringify(await r.json()), `${Date.now() - t0} ms`);
    return;
  }
  let r = await fetch(`${SERVER}/api/rooms/${code}/dub/pack/begin?${q()}`, { method: 'POST' });
  if (!r.ok) return log('FEHLER begin', r.status, await r.text());
  const files = fs.readdirSync(src).filter((f) => fs.statSync(path.join(src, f)).isFile());
  for (const f of files) {
    r = await fetch(`${SERVER}/api/rooms/${code}/dub/pack/file?name=${encodeURIComponent(f)}&${q()}`, { method: 'PUT', body: fs.readFileSync(path.join(src, f)) });
    if (!r.ok) return log('FEHLER Datei', f, r.status);
  }
  r = await fetch(`${SERVER}/api/rooms/${code}/dub/pack/commit?${q()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  log('Ordner hochgeladen:', files.length, 'Dateien,', r.status, JSON.stringify(await r.json()), `${Date.now() - t0} ms`);
}

const packUrl = (u, extra = '') => `${SERVER}${u}${u.includes('?') ? '&' : '?'}${extra}${q()}`;

async function loadPack(version) {
  const r = await fetch(`${SERVER}/api/rooms/${code}/dub/pack.json?${q()}`);
  const j = await r.json();
  if (!j.pack) return;
  pack = j.pack;
  packVersion = j.version;
  const urls = [pack.backing, ...pack.clips.flatMap((c) => [c.audio, c.image])].filter(Boolean);
  const need = new Set(urls).size;
  let have = 0;
  for (const u of new Set(urls)) {
    const res = await fetch(packUrl(u));
    if (res.ok) { await res.arrayBuffer(); have++; }
  }
  log(`Pack „${pack.title}“ geladen: ${pack.clips.length} Zeilen, ${have}/${need} Dateien`);
  wsSend({ type: 'dub.ready', have, need, version });
  // Aus dem Spiel kommen die Dateien nach und nach (und das Web-Pack wird erst gebaut): noch einmal schauen
  if (have < need && tries < 20) { tries++; setTimeout(() => loadPack(version).catch(() => {}), 3000); }
}

function wavPcm(buf) {
  const b = Buffer.from(buf);
  let off = 12, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  return data;
}

function wav(pcm16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm16.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(44100, 24);
  h.writeUInt32LE(88200, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}

async function record(clipId) {
  const clip = pack.clips.find((c) => c.id === clipId);
  sentFor.add(clipId);
  if (mode === 'weg') {
    log('Ich bin dran und gehe weg:', clipId);
    finished = true;
    ws.terminate();
    setTimeout(() => process.exit(0), 300);
    return;
  }
  log(`Ich bin dran: ${clipId} (${(clip.chars || []).join(', ')}) „${clip.caption.slice(0, 50)}“`);
  wsSend({ type: 'dub.activity', what: 'listen' });
  const res = await fetch(packUrl(clip.audio, 'fmt=wav&'));
  let pcm = res.ok ? wavPcm(await res.arrayBuffer()) : null;
  if (!pcm) { log('FEHLER: Clip als WAV nicht geladen', res.status); pcm = Buffer.alloc(44100 * 2); }
  if (mode === 'still') pcm = Buffer.alloc(pcm.length);
  const secs = pcm.length / 88200;
  await new Promise((r) => setTimeout(r, 600));
  wsSend({ type: 'dub.activity', what: 'record' });
  const late = mode === 'spaet' && (!process.env.LATE_CLIP || process.env.LATE_CLIP.split(',').includes(clipId));
  await new Promise((r) => setTimeout(r, Math.min(8000, secs * 1000) + (late ? (Number(process.env.LATE_S) || 15) * 1000 : 300)));
  const up = await fetch(`${SERVER}/api/rooms/${code}/dub/takes/${encodeURIComponent(clipId)}?${q()}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Phone-Score': JSON.stringify({ score: mode === 'still' ? 3 : 97 }) }, body: wav(pcm),
  });
  log('Aufnahme geschickt:', clipId, up.status, (secs).toFixed(2) + ' s', up.ok ? '' : await up.text());
  // Abgelehnt (z. B. Runde gerade in der Lobby): wenn die Zeile wieder dran ist, nochmal
  if (!up.ok) sentFor.delete(clipId);
}

async function finishLead() {
  if (exporting) return;
  exporting = true;
  const out = process.env.OUT;
  const t0 = Date.now();
  wsSend({ type: 'dub.export' });
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const e = st?.export;
    if (e?.status === 'done' || e?.status === 'error') break;
  }
  log('Export:', JSON.stringify(st.export), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const [url, file] of [[`/api/rooms/${code}/dub/export.mp4`, 'export.mp4'], [`/api/rooms/${code}/dub/takes.zip`, 'aufnahmen.zip']]) {
      const r = await fetch(packUrl(url));
      const b = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(out, file), b);
      log(`${file}: ${r.status}, ${b.length} Bytes, ${r.headers.get('content-disposition') || ''}`);
    }
  }
  finished = true;
  log('ENDE');
  setTimeout(() => process.exit(0), 500);
}

function onState(s) {
  const d = s.dub;
  st = d;
  if (!d) return;
  if (d.version !== packVersion && d.packStatus?.status === 'ready' && d.pack) {
    packVersion = d.version;
    loadPack(d.version).catch((e) => log('FEHLER Pack', e.message));
  }
  if (d.phase === 'hub' && pack && process.env.CLAIM) {
    // Figuren kommen mit den Beschreibungen des Packs nach und nach: jede, die frei auftaucht, nehmen (on: true schadet doppelt nicht)
    const want = process.env.CLAIM === 'alle' ? d.characters.map((c) => c.name) : process.env.CLAIM.split(',').map((x) => x.trim());
    const free = d.characters.filter((c) => want.includes(c.name) && !c.claimedBy).map((c) => c.name);
    for (const c of free) wsSend({ type: 'dub.claim', character: c, on: true });
    if (!claimed) {
      claimed = true;
      if (LEAD && process.env.CHRONO === '1') wsSend({ type: 'dub.settings', chrono: true });
      if (LEAD && process.env.WAVES) wsSend({ type: 'dub.settings', waves: process.env.WAVES });
      log('Claime', want.join(', '));
    }
  }
  if (LEAD && d.phase === 'hub' && d.canStart?.ok && d.players.length >= PLAYERS && !d.turns.length && !startTimer) {
    // kurz warten, damit alle noch claimen können
    startTimer = setTimeout(() => {
      log('Starte, Spieler:', st.players.length);
      wsSend({ type: 'dub.start' });
    }, 2500);
  }
  if ((d.phase === 'playing') && d.turn && pack) {
    const mine = d.turn.recorders.find((r) => r.id === me && !r.done && !r.skipped);
    if (mine && !sentFor.has(d.turn.clipId)) record(d.turn.clipId).catch((e) => log('FEHLER Aufnahme', e.message));
  }
  if (d.phase === 'paused' && d.pause && pauseLogged !== d.pause.playerId) { pauseLogged = d.pause.playerId; log('Pause, warte auf', d.pause.name, `(${Math.round((d.pause.until - Date.now()) / 1000)} s)`); }
  if (d.phase !== lastPhase) {
    log('Phase:', d.phase);
    // Neue Runde (zurück in der Lobby): Zeilen dürfen wieder aufgenommen werden
    if (d.phase === 'hub') { sentFor = new Set(); watched = false; }
    lastPhase = d.phase;
  }
  if (d.waitGame !== waitLogged && d.phase === 'results') {
    waitLogged = d.waitGame;
    log(d.waitGame ? 'Server wartet noch auf das Spiel' : 'Spiel ist fertig');
  }
  if (d.phase === 'results' && !watched) {
    watched = true;
    rounds++;
    log(`Fertig: ${d.done}/${d.total} Zeilen, ${d.takes.length} Aufnahmen`);
    if (process.env.WATCH_EARLY === '1') {
      log('Schicke Anschauen sofort (Spiel ist vielleicht noch nicht fertig)');
      wsSend({ type: 'dub.watch' });
    }
    if (LEAD) {
      wsSend({ type: 'dub.watch' });
      setTimeout(() => finishLead(), 3000);
    } else if (rounds >= (Number(process.env.ROUNDS) || 1)) setTimeout(() => { if (!finished) { log('ENDE'); process.exit(0); } }, 20000);
  }
}

code = await roomCode();
const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws');
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'phone', code, name })));
ws.on('message', async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'welcome') {
    token = msg.token;
    me = msg.playerId;
    log('beigetreten, id', me);
    const t = Date.now();
    wsSend({ type: 'dub.time', t });
    if (hostKey) {
      wsSend({ type: 'dub.open', key: hostKey });
      setTimeout(() => uploadPack().catch((e) => log('FEHLER Upload', e.message)), 300);
    }
  } else if (msg.type === 'state') onState(msg.state);
  else if (msg.type === 'dub.time') log(`Zeitabgleich: Abweichung ${msg.server - (msg.t + Date.now()) / 2 | 0} ms, Laufzeit ${Date.now() - msg.t} ms`);
  else if (msg.type === 'dub.watch') log(`Anschauen startet in ${msg.at - Date.now()} ms`);
  else if (msg.type === 'error') log('Server-Fehler', msg.code, msg.message);
});
ws.on('close', () => { log('Verbindung zu'); if (!finished) process.exit(0); });
setTimeout(() => { log('FEHLER: Zeit abgelaufen'); process.exit(1); }, Number(process.env.TIMEOUT_S || 600) * 1000);
