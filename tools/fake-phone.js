// Simuliertes Handy für Tests: tritt einem Raum bei und schickt zu jeder Gameshow-Runde eine Aufnahme.
//   node tools/fake-phone.js <Raumcode|Datei mit Raumcode> [Name] [modus]
// modus: "echo"  = der Original-Clip selbst (perfekte Nachahmung, sollte hohe Punkte geben)
//        "still" = Stille (sollte niedrige Punkte geben)
//        "spaet" = wie echo, aber erst nach 20 s geschickt (das Spiel muss warten)
// WATCH=<Ordner>: schaut das Live-Bild an, zählt Bilder und Ton und legt das letzte Bild dort ab
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');

const [, , codeArg = '', name = 'Handy-Test', mode = 'echo'] = process.argv;
const SERVER = process.env.SERVER || 'http://localhost:8080';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function roomCode() {
  if (/^[A-Z]{4}$/.test(codeArg)) return codeArg;
  for (let i = 0; i < 240; i++) {
    try {
      const c = fs.readFileSync(codeArg, 'utf8').trim();
      if (/^[A-Z]{4}$/.test(c)) return c;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Kein Raumcode gefunden');
}

/** Clip (WAV) -> Aufnahme als WAV, Mono 16 Bit, mit Vorlauf-Stille und auf Länge gebracht.
 *  Ohne ffmpeg: das startet auf manchen PCs sehr langsam und verfälscht dann das Timing. */
function makeTake(clipBytes, leadIn, seconds) {
  const b = Buffer.from(clipBytes);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Clip ist keine WAV-Datei');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22), tag: b.readUInt16LE(off + 8) };
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV ohne fmt/data');
  const bps = fmt.bits / 8;
  const frames = Math.floor(data.length / (bps * fmt.ch));
  const sample = (i, c) => {
    const o = (i * fmt.ch + c) * bps;
    if (fmt.tag === 3) return data.readFloatLE(o);
    if (fmt.bits === 16) return data.readInt16LE(o) / 32768;
    if (fmt.bits === 24) return data.readIntLE(o, 3) / 8388608;
    if (fmt.bits === 32) return data.readInt32LE(o) / 2147483648;
    return (data.readUInt8(o) - 128) / 128;
  };
  const total = Math.round(seconds * fmt.rate);
  const lead = Math.round(leadIn * fmt.rate);
  const out = Buffer.alloc(44 + total * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + total * 2, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(fmt.rate, 24); out.writeUInt32LE(fmt.rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(total * 2, 40);
  if (mode !== 'still') {
    for (let i = 0; i < frames && lead + i < total; i++) {
      let v = 0;
      for (let c = 0; c < fmt.ch; c++) v += sample(i, c);
      v = Math.max(-1, Math.min(1, v / fmt.ch));
      out.writeInt16LE(Math.round(v * 32767), 44 + (lead + i) * 2);
    }
  }
  return out;
}

const code = await roomCode();
log(`Tritt Raum ${code} bei als "${name}" (${mode})`);
const ws = new WebSocket(SERVER.replace('http', 'ws') + '/ws');
let token = '';

const WATCH = process.env.WATCH || '';
const live = { images: 0, audio: 0, bytes: 0, since: Date.now() };
if (WATCH) {
  setInterval(() => {
    if (!live.images && !live.audio) return;
    const s = (Date.now() - live.since) / 1000;
    log(`Live: ${live.images} Bilder (${(live.images / s).toFixed(1)}/s), ${live.audio} Tonpakete, ${(live.bytes / s / 1024).toFixed(0)} KB/s`);
    Object.assign(live, { images: 0, audio: 0, bytes: 0, since: Date.now() });
  }, 10000);
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'phone', code, name })));
ws.on('message', async (data, isBinary) => {
  if (isBinary) {
    live.bytes += data.length;
    if (data[0] === 1) {
      live.images++;
      if (WATCH && live.images % 10 === 1) fs.writeFileSync(`${WATCH}/live.jpg`, data.subarray(1));
    } else if (data[0] === 2) {
      live.audio++;
      if (live.audio === 1) log(`Ton: ${data.readUInt32LE(1)} Hz, ${(data.length - 5) / 2} Samples je Paket`);
    }
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === 'welcome') {
    token = msg.token;
    log('beigetreten, id', msg.playerId);
    if (WATCH) ws.send(JSON.stringify({ type: 'watch', on: true }));
  } else if (msg.type === 'show.round') {
    const r = msg.round;
    log(`Runde ${r.index + 1}/${r.total}: Clip ${r.clipId}, ${r.seconds.toFixed(1)} s, Vorlauf ${r.leadIn.toFixed(3)} s`);
    try {
      const res = await fetch(`${SERVER}/api/rooms/${code}/clips/${encodeURIComponent(r.clipId)}?t=${token}`);
      if (!res.ok) throw new Error('Clip ' + res.status);
      const take = makeTake(Buffer.from(await res.arrayBuffer()), r.leadIn, r.seconds);
      const late = mode === 'spaet' ? 20000 : 0;
      await new Promise((ok) => setTimeout(ok, 2000 + r.countdown * 1000 + late));   // so lange wie ein echtes Handy
      const up = await fetch(`${SERVER}/api/rooms/${code}/rounds/${r.roundId}/recording?t=${token}`, {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: take,
      });
      log('Aufnahme geschickt:', up.status, take.length, 'Bytes');
    } catch (e) {
      log('FEHLER', e.message);
    }
  } else if (msg.type === 'show.scores') {
    log('Punkte:', msg.scores.map((s) => `${s.name} ${s.score} (gesamt ${s.total})`).join(' | '));
  } else if (msg.type === 'show.end') {
    log('ENDE, Rangliste:', msg.ranking.map((s) => `${s.place}. ${s.name} ${s.total}`).join(' | '));
    process.exit(0);
  } else if (msg.type === 'error') {
    log('Server-Fehler', msg.code, msg.message);
  }
});
ws.on('close', () => { log('Verbindung zu'); process.exit(0); });
