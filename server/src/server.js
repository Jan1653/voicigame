import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Room } from './room.js';
import { relayFrame } from './stream.js';
import { allowRoom, MAX_ROOMS, MAX_PLAYERS_PER_ROOM, checkStorage, storageAdd } from './limits.js';
import { installDub } from './dub.js';
import { count as countStat, flush as flushStats, startAutoFlush } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unerwartete Fehler protokollieren statt den Server (und damit alle Räume) zu beenden
process.on('unhandledRejection', (e) => console.error('Unbehandelter Fehler:', e));
process.on('uncaughtException', (e) => console.error('Unerwarteter Fehler:', e));
// Beim Beenden (Update, Neustart) die Statistik noch schreiben
startAutoFlush();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushStats(); process.exit(0); });
const PORT = Number(process.env.PORT) || 8080;
// Nur auf dieser Adresse lauschen, z. B. 127.0.0.1 hinter Caddy. Leer = alle Adressen.
const HOST = process.env.HOST || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// Je Port ein eigener Ordner: zwei Server auf einem Rechner räumen sich beim Start nicht gegenseitig auf
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), `voicigame-${PORT}`);
const ROOM_IDLE_MS = 45 * 60 * 1000;     // niemand mehr verbunden
const ROOM_CLOSED_MS = 5 * 60 * 1000;    // Host hat den Raum geschlossen (Handys sehen noch kurz den Hinweis)

fs.mkdirSync(DATA_DIR, { recursive: true });
// Räume leben nur im Speicher: Ordner von Räumen vor einem Neustart sind verwaist
for (const name of fs.readdirSync(DATA_DIR)) {
  if (/^[A-Z]{4}$/.test(name)) fs.rmSync(path.join(DATA_DIR, name), { recursive: true, force: true });
}
const rooms = new Map();

/* ---------- ffmpeg (optional) ----------
 * Handys können nicht jedes Format abspielen (z. B. Ogg auf iPhones).
 * Wenn ffmpeg da ist, wird alles, was kein MP3/WAV/AAC ist, zu MP3 umgewandelt. */
let FFMPEG = null;
try {
  FFMPEG = (await import('ffmpeg-static')).default || null;
} catch {}
if (!FFMPEG && spawnSync('ffmpeg', ['-version']).status === 0) FFMPEG = 'ffmpeg';
console.log(FFMPEG ? `ffmpeg gefunden: ${FFMPEG}` : 'ffmpeg nicht gefunden, Clips werden unverändert weitergegeben');

const PHONE_SAFE = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aac', 'audio/mp4', 'audio/x-m4a']);
const EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/flac': 'flac' };

function toMp3(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-b:a', '112k', output]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))));
  });
}

/* ---------- Hilfen ---------- */

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  while (rooms.has(code));
  return code;
}

const joinUrl = (room) => `${PUBLIC_URL}/?r=${room.code}`;
const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));

function toHosts(room, msg) {
  for (const ws of room.hosts) send(ws, msg);
}

function toPhones(room, msg) {
  for (const p of room.players.values()) if (p.kind === 'phone') send(p.ws, msg);
}

const pendingBroadcast = new Set();
function broadcastState(room) {
  if (pendingBroadcast.has(room)) return;
  pendingBroadcast.add(room);
  setTimeout(() => {
    pendingBroadcast.delete(room);
    const hostView = room.view();
    toHosts(room, { type: 'state', state: hostView });
    for (const p of room.players.values()) if (p.kind === 'phone' && p.ws) send(p.ws, { type: 'state', state: room.view(p.id) });
  }, 30);
}

function getRoom(req, res) {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) {
    res.status(404).json({ error: 'room_not_found' });
    return null;
  }
  room.touch();
  return room;
}

const isHost = (room, req) => (req.get('x-host-key') || req.query.k) === room.hostKey;

/* ---------- HTTP ---------- */

const app = express();
app.disable('x-powered-by');
// Hinter einem Proxy (Caddy auf demselben Rechner oder im selben Docker-Netz) die echte Adresse des Besuchers nehmen
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, uniquelocal');

// Für das Update-Skript (deploy/update.sh): läuft der Server, wird gerade gespielt? Nur von diesem Rechner aus.
app.get('/api/health', (req, res) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) return res.status(404).end();
  let busy = 0;
  for (const room of rooms.values()) {
    if (room.hosts.size || [...room.players.values()].some((p) => p.connected && p.kind === 'phone')) busy++;
  }
  res.json({ ok: true, rooms: rooms.size, busy });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// Dub-Modus (Synchronisieren): eigene Datei
const dub = installDub(app, { getRoom, isHost, send, toHosts, toPhones, broadcastState });

app.post('/api/rooms', (req, res) => {
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'too_many_rooms', message: 'Gerade sind zu viele Räume offen. Versuch es gleich nochmal.' });
  }
  if (!allowRoom(req.ip)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Zu viele neue Räume. Warte ein paar Minuten.' });
  }
  const room = new Room(newCode(), DATA_DIR);
  rooms.set(room.code, room);
  if (req.query.game === 'dub') dub.open(room, 'browser');
  console.log(`Raum ${room.code} erstellt`);
  countStat('rooms');
  res.json({ code: room.code, hostKey: room.hostKey, joinUrl: joinUrl(room) });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req, res);
  if (room) res.json({ code: room.code, phase: room.phase });
});

app.get('/api/rooms/:code/qr.png', async (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const png = await QRCode.toBuffer(joinUrl(room), { width: 480, margin: 1, color: { dark: '#063a5c', light: '#ffffff' } });
  res.type('png').send(png);
});

// Host lädt einen Clip hoch
app.put('/api/rooms/:code/clips/:clipId', express.raw({ type: () => true, limit: '60mb' }), async (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  if (!isHost(room, req)) return res.status(403).json({ error: 'forbidden' });
  if (!req.body?.length) return res.status(400).json({ error: 'empty' });
  if (!checkStorage(res, DATA_DIR, req.body.length)) return;
  storageAdd(req.body.length);

  const clip = room.ensureClip(String(req.params.clipId));
  const mime = (req.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const safeId = clip.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const raw = path.join(room.dir, 'clips', `${safeId}.${EXT[mime] || 'bin'}`);
  fs.writeFileSync(raw, req.body);

  let file = raw;
  let outMime = mime;
  if (!PHONE_SAFE.has(mime) && FFMPEG) {
    const mp3 = path.join(room.dir, 'clips', `${safeId}.conv.mp3`);
    try {
      await toMp3(raw, mp3);
      file = mp3;
      outMime = 'audio/mpeg';
    } catch (e) {
      console.warn(`Umwandlung von ${clip.id} fehlgeschlagen:`, e.message);
    }
  }
  clip.file = file;
  clip.mime = outMime;
  clip.size = fs.statSync(file).size;
  clip.available = true;
  // Alte Kopie im Handy-Cache ist evtl. veraltet
  for (const p of room.players.values()) p.cached.delete(clip.id);
  broadcastState(room);
  res.json({ ok: true, id: clip.id, mime: outMime, size: clip.size });
});

// Handy oder Host lädt einen Clip herunter
app.get('/api/rooms/:code/clips/:clipId', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const player = room.findByToken(req.query.t);
  if (!player && !isHost(room, req)) return res.status(403).json({ error: 'forbidden' });
  const clip = room.clip(String(req.params.clipId));
  if (!clip?.available) return res.status(404).json({ error: 'clip_not_ready' });
  res.set('Cache-Control', 'private, max-age=3600');
  res.type(clip.mime).sendFile(clip.file);
});

// Handy schickt seine Aufnahme (WAV, 16 Bit, Mono)
app.post('/api/rooms/:code/turns/:turnId/recording', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const player = room.findByToken(req.query.t);
  const turn = room.turn;
  if (!player || !turn || turn.turnId !== req.params.turnId || turn.playerId !== player.id) {
    return res.status(409).json({ error: 'not_your_turn' });
  }
  if (!req.body?.length) return res.status(400).json({ error: 'empty' });
  fs.writeFileSync(path.join(room.dir, 'rec', `${turn.turnId}.wav`), req.body);
  turn.status = 'recorded';
  turn.phoneScore = parsePhoneScore(req.get('x-phone-score'));
  toHosts(room, {
    type: 'recording.ready',
    turnId: turn.turnId,
    playerId: player.id,
    url: `/api/rooms/${room.code}/turns/${turn.turnId}/recording`,
    bytes: req.body.length,
    phoneScore: turn.phoneScore,
  });
  broadcastState(room);
  res.json({ ok: true });
});

app.get('/api/rooms/:code/turns/:turnId/recording', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  if (!isHost(room, req)) return res.status(403).json({ error: 'forbidden' });
  const f = path.join(room.dir, 'rec', `${String(req.params.turnId).replace(/[^a-f0-9]/g, '')}.wav`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not_found' });
  res.type('audio/wav').sendFile(f);
});

// Gameshow: Handy schickt seine Aufnahme zur laufenden Runde
app.post('/api/rooms/:code/rounds/:roundId/recording', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const player = room.findByToken(req.query.t);
  const roundId = String(req.params.roundId).replace(/[^a-f0-9]/g, '');
  if (!player) return res.status(403).json({ error: 'forbidden' });
  if (!req.body?.length) return res.status(400).json({ error: 'empty' });
  const file = path.join(room.dir, 'rec', `show_${roundId}_${player.id}.wav`);
  const phoneScore = parsePhoneScore(req.get('x-phone-score'));
  if (!checkStorage(res, DATA_DIR, req.body.length)) return;
  if (!room.acceptShowRecording(roundId, player.id, file, phoneScore)) return res.status(409).json({ error: 'not_your_round' });
  storageAdd(req.body.length);
  fs.writeFileSync(file, req.body);
  toHosts(room, {
    type: 'show.recording',
    roundId,
    playerId: player.id,
    url: `/api/rooms/${room.code}/rounds/${roundId}/recording/${player.id}`,
    bytes: req.body.length,
    phoneScore,
  });
  broadcastState(room);
  res.json({ ok: true });
});

app.get('/api/rooms/:code/rounds/:roundId/recording/:playerId', (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  if (!isHost(room, req)) return res.status(403).json({ error: 'forbidden' });
  const roundId = String(req.params.roundId).replace(/[^a-f0-9]/g, '');
  const playerId = String(req.params.playerId).replace(/[^a-z0-9]/g, '');
  const f = path.join(room.dir, 'rec', `show_${roundId}_${playerId}.wav`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not_found' });
  res.type('audio/wav').sendFile(f);
});

/** Auswertung vom Handy (Tonhöhe, Timing, Länge). Nur Zahlen und kurze Texte übernehmen. */
function parsePhoneScore(raw) {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    const num = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(100, Math.round(+v))) : 0);
    return {
      score: num(d.score), pitch: num(d.pitch), rhythm: num(d.rhythm), length: num(d.length),
      grade: String(d.grade || '').slice(0, 4), text: String(d.text || '').slice(0, 120),
    };
  } catch {
    return null;
  }
}

/* ---------- WebSocket ---------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  let room = null;
  let role = null;
  let player = null;

  ws.on('message', (data, isBinary) => {
    // Live-Bild und Ton vom Host (siehe stream.js)
    if (isBinary) {
      if (role === 'host' && room) relayFrame(room, data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (!role) {
      if (msg.type !== 'hello') return;
      room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', code: 'room_not_found', message: 'Diesen Raum gibt es nicht (mehr).' });
      room.touch();
      if (msg.role === 'host') {
        if (msg.key !== room.hostKey) return send(ws, { type: 'error', code: 'forbidden', message: 'Falscher Host-Schlüssel.' });
        role = 'host';
        room.hosts.add(ws);
        room.closed = false;
        send(ws, { type: 'welcome', role, code: room.code, joinUrl: joinUrl(room) });
        broadcastState(room); // Handys sehen: PC ist (wieder) da
        send(ws, { type: 'state', state: room.view() });
        if (room.turn) send(ws, { type: 'turn.started', turn: turnInfo(room) });
        return;
      }
      let p = room.findByToken(msg.token);
      if (p?.left) p = null;
      if (!p) {
        const phones = [...room.players.values()].filter((x) => x.kind === 'phone' && !x.left).length;
        if (phones >= MAX_PLAYERS_PER_ROOM) {
          // Nicht anmelden: sonst gilt die Verbindung als Handy ohne Spieler
          send(ws, { type: 'error', code: 'room_full', message: 'Der Raum ist voll.' });
          ws.close(4002, 'room_full');
          return;
        }
        p = room.addPhone(msg.name);
        countStat('players');
      } else if (msg.name) p.name = String(msg.name).slice(0, 24) || p.name;
      role = 'phone';
      player = p;
      if (player.ws && player.ws !== ws) player.ws.close(4000, 'replaced');
      player.ws = ws;
      player.connected = true;
      dub.onConnect(room, player);
      send(ws, { type: 'welcome', role, playerId: player.id, token: player.token, name: player.name });
      broadcastState(room);
      return;
    }

    room.touch();
    // Ein Fehler in einer Nachricht darf nicht den ganzen Server (alle Räume) beenden
    try {
      if (role === 'host') handleHost(room, ws, msg);
      else if (player) handlePhone(room, player, msg);
    } catch (e) {
      console.error(`Fehler bei Nachricht ${msg.type} in Raum ${room.code}:`, e);
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (role === 'host') {
      room.hosts.delete(ws);
      broadcastState(room); // Handys sehen: PC ist weg
    }
    if (role === 'phone' && player && player.ws === ws) {
      player.ws = null;
      player.connected = false;
      dub.onDisconnect(room, player);
      broadcastState(room);
    }
  });
});

function turnInfo(room) {
  const t = room.turn;
  if (!t) return null;
  const p = t.playerId ? room.players.get(t.playerId) : null;
  const c = room.clip(t.clipId);
  return {
    ...t,
    total: room.schedule.length,
    player: p ? { id: p.id, name: p.name, kind: p.kind, slot: p.slot, connected: p.connected } : null,
    clip: c ? { id: c.id, title: c.title, character: c.character, duration: c.duration } : null,
  };
}

function handleHost(room, ws, msg) {
  if (dub.onHost(room, ws, msg)) return;
  const err = (code, message) => send(ws, { type: 'error', code, message });
  switch (msg.type) {
    case 'local.set':
      room.setLocalPlayers(msg.players);
      break;
    case 'clips.set':
      room.setClips(msg.clips);
      break;
    case 'settings.set':
      if (room.phase !== 'lobby' && msg.mode) return err('locked', 'Der Modus kann nur in der Lobby geändert werden.');
      if (msg.mode === 'claim' || msg.mode === 'chrono') room.settings.mode = msg.mode;
      if (typeof msg.preload === 'boolean') room.settings.preload = msg.preload;
      room.recompute();
      break;
    case 'claim.set':
      if (!room.setClaim(String(msg.character), msg.playerId || null, { force: true })) return err('claim_failed', 'Zuweisung nicht möglich.');
      break;
    case 'player.kick': {
      const p = room.players.get(msg.playerId);
      if (p?.kind === 'phone') {
        send(p.ws, { type: 'kicked' });
        p.ws?.close(4001, 'kicked');
      }
      room.removePlayer(msg.playerId);
      dub.onRemoved(room, msg.playerId);
      break;
    }
    case 'game.start': {
      const check = room.canStart();
      if (!check.ok && !(msg.force && room.phase === 'lobby' && room.clips.length)) return err('cannot_start', check.reason);
      room.start();
      toHosts(room, { type: 'game.started' });
      toPhones(room, { type: 'game.started' });
      break;
    }
    case 'turn.next': {
      if (room.turn && room.turn.status !== 'done') {
        room.results.push({ turnId: room.turn.turnId, clipId: room.turn.clipId, playerId: room.turn.playerId, skipped: true });
      }
      const t = room.nextTurn();
      if (!t) {
        toHosts(room, { type: 'game.ended' });
        toPhones(room, { type: 'game.ended' });
        break;
      }
      const info = turnInfo(room);
      toHosts(room, { type: 'turn.started', turn: info });
      toPhones(room, { type: 'turn.started', turn: info });
      break;
    }
    case 'turn.record': {
      const t = room.turn;
      if (!t || t.turnId !== msg.turnId) return err('stale_turn', 'Diese Runde ist nicht mehr aktiv.');
      const p = room.players.get(t.playerId);
      if (p?.kind !== 'phone') return err('not_phone', 'Diese Runde gehört keinem Handy.');
      t.status = 'recording';
      const seconds = Math.min(60, Math.max(1, Number(msg.seconds) || 5));
      const countdown = Math.min(5, Math.max(0, Math.round(Number(msg.countdown ?? 3))));
      send(p.ws, { type: 'turn.record', turnId: t.turnId, seconds, countdown });
      break;
    }
    case 'turn.result': {
      const t = room.turn;
      if (!t || t.turnId !== msg.turnId) return err('stale_turn', 'Diese Runde ist nicht mehr aktiv.');
      t.status = 'done';
      const r = {
        turnId: t.turnId, clipId: t.clipId, playerId: t.playerId,
        score: Number.isFinite(+msg.score) ? +msg.score : null,
        grade: msg.grade ? String(msg.grade).slice(0, 12) : null,
        text: msg.text ? String(msg.text).slice(0, 200) : null,
      };
      room.results.push(r);
      toPhones(room, { type: 'turn.result', result: r });
      break;
    }
    case 'game.end':
      // Host schließt den Raum (Lobby „Zurück“ oder Spiel beendet)
      room.phase = 'ended';
      room.turn = null;
      // Dub-Runde läuft noch: beenden, sonst warten die Browser auf Zeilen, die nie mehr kommen
      if (room.dub && ['playing', 'paused'].includes(room.dub.phase)) room.dub.toHub();
      room.closed = true;
      room.closedAt = Date.now();
      toHosts(room, { type: 'game.ended' });
      toPhones(room, { type: 'game.ended' });
      break;
    case 'game.reset':
      room.backToLobby();
      break;
    // ---------- Gameshow ----------
    case 'show.round': {
      if (!room.clip(String(msg.clipId))?.available) return err('clip_not_ready', 'Der Clip ist noch nicht hochgeladen.');
      const r = room.startShowRound(msg);
      if (Number(msg.index) === 0) countStat('shows');   // erste Runde = eine Gameshow
      room.show.status = '';
      for (const id of r.recorders) {
        const p = room.players.get(id);
        send(p?.ws, { type: 'show.round', round: room.showView(id).round });
      }
      break;
    }
    case 'show.status':
      room.show.status = String(msg.text || '').slice(0, 140);
      break;
    case 'show.scores': {
      const list = Array.isArray(msg.scores) ? msg.scores : [];
      room.show.scores = list.slice(0, 16).map((x) => ({
        playerId: x.playerId ? String(x.playerId) : null,
        name: String(x.name || '').slice(0, 32),
        score: Number.isFinite(+x.score) ? +x.score : null,
        total: Number.isFinite(+x.total) ? +x.total : null,
        web: !!x.web,
      }));
      toPhones(room, { type: 'show.scores', index: Number(msg.index) || 0, scores: room.show.scores });
      break;
    }
    case 'show.end': {
      const list = Array.isArray(msg.ranking) ? msg.ranking : room.show.scores;
      room.show.ranking = list.slice(0, 16).map((x, i) => ({
        place: i + 1, playerId: x.playerId ? String(x.playerId) : null, name: String(x.name || '').slice(0, 32),
        total: Number.isFinite(+x.total) ? +x.total : null, web: !!x.web,
      }));
      room.show.round = null;
      room.phase = 'ended';
      toPhones(room, { type: 'show.end', ranking: room.show.ranking });
      break;
    }
    default:
      return;
  }
  broadcastState(room);
}

function handlePhone(room, player, msg) {
  if (dub.onPhone(room, player, msg)) return;
  switch (msg.type) {
    case 'watch':
      player.watch = !!msg.on;
      break;
    case 'claim.toggle':
      room.toggleClaim(String(msg.character), player.id);
      break;
    case 'clip.cached': {
      const ids = Array.isArray(msg.clipIds) ? msg.clipIds : [msg.clipId];
      for (const id of ids) if (room.clip(String(id))) player.cached.add(String(id));
      const t = room.turn;
      if (t && t.playerId === player.id && t.status === 'loading' && player.cached.has(t.clipId)) {
        t.status = 'ready';
        toHosts(room, { type: 'turn.player_ready', turnId: t.turnId, playerId: player.id });
      }
      break;
    }
    case 'turn.progress': {
      const t = room.turn;
      if (t && t.turnId === msg.turnId && t.playerId === player.id) {
        toHosts(room, { type: 'turn.progress', turnId: t.turnId, pct: Math.max(0, Math.min(1, Number(msg.pct) || 0)) });
      }
      return; // kein State-Broadcast nötig
    }
    case 'leave':
      room.removePlayer(player.id);
      dub.onRemoved(room, player.id);
      player.ws?.close(1000, 'left');
      break;
    default:
      return;
  }
  broadcastState(room);
}

// Tote Verbindungen erkennen
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

// Alte Räume aufräumen
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const active = room.hosts.size || [...room.players.values()].some((p) => p.connected && p.kind === 'phone');
    const closed = room.closed && !room.hosts.size && now - room.closedAt > ROOM_CLOSED_MS;
    if (closed || (!active && now - room.lastActive > ROOM_IDLE_MS)) {
      room.dub?.destroy();
      room.destroy();
      rooms.delete(code);
      console.log(`Raum ${code} entfernt (inaktiv)`);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, ...(HOST ? [HOST] : []), () => {
  console.log(`Server läuft auf ${HOST || 'allen Adressen'}, Port ${PORT}`);
  console.log(`Öffentliche Adresse: ${PUBLIC_URL}`);
});
