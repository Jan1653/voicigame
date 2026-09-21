// Simulierter Spiel-Host für Tests der Handy-Seite ohne Spiel: legt einen Raum an, lädt Clips hoch
// und spielt eine Gameshow. Sobald ein Handy beigetreten ist, startet Runde 1.
//   node tools/fake-host.js <clip.wav> [clip2.wav ...]
// Umgebung: SERVER (Standard http://localhost:8080), ROOM_FILE (schreibt den Raumcode hinein)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

const SERVER = process.env.SERVER || 'http://localhost:8080';
const files = process.argv.slice(2);
if (!files.length) {
  console.error('Aufruf: node tools/fake-host.js <clip.wav> [clip2.wav ...]');
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
process.on('uncaughtException', (e) => log('FEHLER', e.stack || e));
process.on('unhandledRejection', (e) => log('FEHLER', e?.stack || e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.HEARTBEAT) setInterval(() => log(`lebt, Runde ${round}, Zustand ${state?.phase}`), 3000);

const res = await fetch(`${SERVER}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const { code, hostKey, joinUrl } = await res.json();
log(`Raum ${code}, beitreten: ${joinUrl}`);
if (process.env.ROOM_FILE) fs.writeFileSync(process.env.ROOM_FILE, code);

const ws = new WebSocket(SERVER.replace('http', 'ws') + '/ws');
const send = (m) => ws.send(JSON.stringify(m));
let state = null;
let round = -1;
const got = new Set();
const totals = {};

ws.on('open', async () => {
  send({ type: 'hello', role: 'host', code, key: hostKey });
  send({ type: 'clips.set', clips: files.map((f, i) => ({ id: String(i), title: path.basename(f, path.extname(f)), character: '', order: i })) });
  for (let i = 0; i < files.length; i++) {
    const up = await fetch(`${SERVER}/api/rooms/${code}/clips/${i}`, {
      method: 'PUT', headers: { 'Content-Type': 'audio/wav', 'X-Host-Key': hostKey }, body: fs.readFileSync(files[i]),
    });
    log(`Clip ${i} hochgeladen: ${up.status}`);
  }
});

const phones = () => (state?.players || []).filter((p) => p.kind === 'phone' && p.connected);

async function nextRound() {
  round++;
  got.clear();
  if (round >= files.length) {
    const ranking = [{ name: 'PC-Spieler', total: 1 }, ...phones().map((p) => ({ playerId: p.id, name: p.name, total: totals[p.id] || 0, web: true }))]
      .sort((a, b) => b.total - a.total);
    send({ type: 'show.end', ranking });
    log('Show beendet');
    return;
  }
  const seconds = 4.5;
  send({ type: 'show.round', index: round, total: files.length, clipId: String(round), seconds, countdown: 3, leadIn: 0.417, recorders: [] });
  send({ type: 'show.status', text: 'PC-Spieler ist dran' });
  log(`Runde ${round + 1} gestartet`);
}

async function finishRound() {
  send({ type: 'show.status', text: '' });
  const scores = [{ name: 'PC-Spieler', score: round === 0 ? 1 : 0, total: 1 }];
  for (const p of phones()) {
    const s = 2 + round;
    totals[p.id] = (totals[p.id] || 0) + s;
    scores.push({ playerId: p.id, name: p.name, score: s, total: totals[p.id], web: true });
  }
  send({ type: 'show.scores', index: round, scores });
  log('Punkte geschickt');
  await sleep(4000);
  nextRound();
}

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'state') {
    state = msg.state;
    if (round === -1 && phones().length && state.clips.every((c) => c.available)) {
      round = -2; // nur einmal starten
      log('Handy da, Show startet in 3 s');
      setTimeout(() => { round = -1; nextRound(); }, 3000);
    }
  } else if (msg.type === 'show.recording') {
    log(`Aufnahme gemeldet, Runde ${msg.roundId}, Handys: ${phones().map((p) => p.id).join(',')}`);
    got.add(msg.playerId);
    log(`Aufnahme von ${msg.playerId}: ${msg.bytes} Bytes`);
    if (phones().every((p) => got.has(p.id))) finishRound();
  } else if (msg.type === 'error') {
    log('Server-Fehler', msg.code, msg.message);
  }
});
ws.on('close', () => { log('Verbindung zu'); process.exit(0); });
