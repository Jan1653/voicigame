import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/* =====================================================================
 * Dateien rund um Dub-Packs, ohne Zusatzpakete:
 *   ZIP lesen (Pack-Upload) und schreiben (Aufnahmen zum Mitnehmen)
 *   .ini des Spiels lesen (Godot-ConfigFile)
 *   Länge von WAV und Ogg (Vorbis, Opus) bestimmen
 *   Pack-Ordner einlesen (so wie das Spiel ihn liest)
 * ===================================================================== */

export const AUDIO_EXT = ['ogg', 'wav', 'mp3', 'flac', 'm4a', 'opus', 'aac'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg'];
export const VIDEO_EXT = ['ogv', 'mp4', 'webm', 'mkv', 'mov'];
const RESERVED_AUDIO = ['_backing_track', '_ignore', '_dubrecord_freestyle'];

const ext = (name) => path.extname(name).slice(1).toLowerCase();
const base = (name) => path.basename(name, path.extname(name));

/** Dateiname für den Pack-Ordner: nur der Name, keine Pfadteile, keine Steuerzeichen. */
export function safeName(name) {
  const n = String(name || '').replace(/\\/g, '/').split('/').pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  if (!n || n === '.' || n === '..') return null;
  return n.slice(0, 180);
}

/* ---------------- CRC32 (für ZIP) ---------------- */

let CRC_TABLE = null;
function crc32(buf, crc = 0) {
  if (zlib.crc32) return zlib.crc32(buf, crc);
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/* ---------------- ZIP lesen ---------------- */

/** Inhaltsverzeichnis einer ZIP-Datei. -> [{name, method, csize, size, offset, dir}] */
export function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const tailLen = Math.min(total, 65557 + 20);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, total - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Keine gültige ZIP-Datei.');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    // ZIP64
    if (cdOff === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64 = Number(tail.readBigUInt64LE(loc + 8));
        const rec = Buffer.alloc(56);
        fs.readSync(fd, rec, 0, 56, z64);
        if (rec.readUInt32LE(0) === 0x06064b50) {
          count = Number(rec.readBigUInt64LE(32));
          cdSize = Number(rec.readBigUInt64LE(40));
          cdOff = Number(rec.readBigUInt64LE(48));
        }
      }
    }
    if (count > 20000) throw new Error('Zu viele Dateien in der ZIP-Datei.');
    // Inhaltsverzeichnis muss in der Datei liegen und darf nicht riesig sein (sonst Speicher voll)
    if (cdSize > 64 * 1024 * 1024 || cdOff + cdSize > total) throw new Error('ZIP-Datei beschädigt.');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
      // ZIP64-Zusatzfeld
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) {
          let q = x + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      out.push({ name: name.replace(/\\/g, '/'), method, csize, size, offset, dir: name.endsWith('/') || name.endsWith('\\') });
      p = xend + clen;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Einen Eintrag entpacken. maxBytes schützt vor „ZIP-Bomben“. */
export async function zipExtract(file, entry, dest, maxBytes) {
  const fd = fs.openSync(file, 'r');
  let start;
  try {
    const h = Buffer.alloc(30);
    fs.readSync(fd, h, 0, 30, entry.offset);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP-Datei beschädigt.');
    start = entry.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Packmethode ${entry.method} wird nicht unterstützt.`);
  const src = fs.createReadStream(file, { start, end: start + Math.max(0, entry.csize) - 1 });
  let bytes = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new Error('Datei in der ZIP-Datei ist zu groß.'));
      cb(null, chunk);
    },
  });
  const steps = [src];
  if (entry.method === 8) steps.push(zlib.createInflateRaw());
  steps.push(guard, fs.createWriteStream(dest));
  if (entry.csize === 0) {
    fs.writeFileSync(dest, Buffer.alloc(0));
    return 0;
  }
  await pipeline(...steps);
  return bytes;
}

/**
 * Pack aus einer ZIP-Datei holen: den Ordner mit Video und Zeilen suchen und nur dessen Dateien
 * (ohne Unterordner) nach dest entpacken. -> Anzahl Dateien
 */
export async function extractPackZip(zipFile, dest, maxTotal) {
  const entries = zipEntries(zipFile).filter((e) => !e.dir && !e.name.split('/').includes('__MACOSX'));
  const dirs = new Map();
  for (const e of entries) {
    const d = path.posix.dirname(e.name);
    const f = path.posix.basename(e.name).toLowerCase();
    const s = dirs.get(d) || { video: 0, audio: 0, ini: 0 };
    if (/^dub_video\./.test(f)) s.video++;
    if (AUDIO_EXT.includes(ext(f)) && !f.startsWith('_')) s.audio++;
    if (f.endsWith('.ini') || f.endsWith('.txt')) s.ini++;
    dirs.set(d, s);
  }
  let best = null, bestScore = -1;
  for (const [d, s] of dirs) {
    const score = s.video * 1000 + Math.min(s.audio, s.ini) * 2 + s.audio;
    if (s.audio && score > bestScore) { best = d; bestScore = score; }
  }
  if (best === null) throw new Error('In der ZIP-Datei ist kein Pack (keine Clips gefunden).');
  fs.mkdirSync(dest, { recursive: true });
  let total = 0, written = 0, n = 0;
  for (const e of entries) {
    if (path.posix.dirname(e.name) !== best) continue;
    const name = safeName(path.posix.basename(e.name));
    if (!name) continue;
    total += e.size;
    if (total > maxTotal) throw new Error('Das Pack ist zu groß.');
    // Grenze ist, was vom Gesamtbudget noch übrig ist: die Größenangaben in der ZIP können lügen
    written += await zipExtract(zipFile, e, path.join(dest, name), maxTotal - written);
    n++;
  }
  return n;
}

/* ---------------- ZIP schreiben (ohne Kompression, WAV lässt sich kaum packen) ---------------- */

/** files: [{name, file}] -> schreibt out. */
export function writeZip(out, files) {
  const fd = fs.openSync(out, 'w');
  const central = [];
  let pos = 0;
  const write = (buf) => { fs.writeSync(fd, buf); pos += buf.length; };
  try {
    for (const f of files) {
      const data = fs.readFileSync(f.file);
      const name = Buffer.from(f.name, 'utf8');
      const crc = crc32(data);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(0, 8);
      h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
      const offset = pos;
      write(h); write(name); write(data);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
      c.writeUInt16LE(0, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([c, name]));
    }
    const cdStart = pos;
    for (const c of central) write(c);
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10);
    e.writeUInt32LE(pos - cdStart, 12); e.writeUInt32LE(cdStart, 16);
    write(e);
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------------- .ini des Spiels (Godot-ConfigFile) ---------------- */

/** Liest key=value-Paare, Werte wie Godot sie schreibt: "Text" (auch mehrzeilig), Zahlen, [Listen], PackedXArray(...). */
export function parseIni(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // BOM
  const out = {};
  let i = 0;
  const ws = () => { while (i < s.length && /[ \t\r]/.test(s[i])) i++; };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '"') {
      i++;
      let str = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          str += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n;
          i += 2;
        } else str += s[i++];
      }
      i++;
      return str;
    }
    if (c === '[' || s.startsWith('Packed', i)) {
      if (c !== '[') { while (i < s.length && s[i] !== '(') i++; }
      const close = s[i] === '[' ? ']' : ')';
      i++;
      const arr = [];
      for (;;) {
        ws();
        while (s[i] === '\n' || s[i] === ',') { i++; ws(); }
        if (i >= s.length || s[i] === close) { i++; break; }
        const at = i;
        arr.push(value());
        // Unerwartetes Zeichen (z. B. falsche Klammer): überspringen, sonst endlos leere Werte
        if (i === at) i++;
        if (arr.length > 100000) break;
      }
      return arr;
    }
    let raw = '';
    while (i < s.length && !/[\n,\])]/.test(s[i])) raw += s[i++];
    raw = raw.trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return Number(raw);
    return raw;
  };
  while (i < s.length) {
    ws();
    if (s[i] === '\n') { i++; continue; }
    if (s[i] === '[' || s[i] === ';' || s[i] === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    let key = '';
    while (i < s.length && s[i] !== '=' && s[i] !== '\n') key += s[i++];
    if (s[i] !== '=') continue;
    i++;
    out[key.trim()] = value();
    while (i < s.length && s[i] !== '\n') i++;
  }
  return out;
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

/* ---------------- Längen ---------------- */

/** Länge einer Audiodatei in Sekunden (WAV, Ogg Vorbis/Opus). 0 = unbekannt. */
export function audioDuration(file) {
  try {
    const e = ext(file);
    if (e === 'wav') return wavInfo(fs.readFileSync(file))?.duration || 0;
    if (e === 'ogg' || e === 'opus' || e === 'ogv') return oggDuration(file);
  } catch {}
  return 0;
}

export function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = { start: off + 8, size: Math.min(size, buf.length - off - 8) }; break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) return null;
  // Kaputte Kopfdaten (0 Kanäle, Rate 0, krumme Bits) ergäben unendlich viele Samples
  if (!fmt.channels || fmt.channels > 16 || !fmt.rate || fmt.rate > 384000 || !fmt.bits || fmt.bits % 8) return null;
  const frame = (fmt.bits / 8) * fmt.channels;
  return { ...fmt, dataStart: data.start, dataSize: data.size, frames: Math.floor(data.size / frame), duration: data.size / frame / fmt.rate };
}

function oggDuration(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    let rate = 0, preskip = 0, opus = false;
    const v = head.indexOf('\x01vorbis', 0, 'latin1');
    if (v >= 0) rate = head.readUInt32LE(v + 12);
    const o = head.indexOf('OpusHead', 0, 'latin1');
    if (o >= 0) { opus = true; rate = 48000; preskip = head.readUInt16LE(o + 10); }
    if (!rate) return 0;
    const n = Math.min(size, 65536);
    const tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    for (let i = n - 14; i >= 0; i--) {
      if (tail[i] === 0x4f && tail.toString('latin1', i, i + 4) === 'OggS') {
        const g = Number(tail.readBigInt64LE(i + 6));
        if (g > 0) return Math.max(0, (g - (opus ? preskip : 0)) / rate);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

/* ---------------- Pack einlesen ---------------- */

/**
 * Liest einen Pack-Ordner (flach, so wie das Spiel Dub-Packs liest).
 * -> {title, subtitle, authors, readme, icon, video, backing, clips:[{id, audio, image, caption, chars, times, dubOnly, duration}]}
 */
export function readPack(dir) {
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const byBase = new Map();
  for (const f of files) {
    const b = base(f).toLowerCase();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }
  const find = (b, exts) => (byBase.get(String(b).toLowerCase()) || []).find((f) => exts.includes(ext(f))) || null;
  const readText = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };

  const infoFile = find('_pack_info', ['ini', 'txt', 'cfg']);
  const info = infoFile ? parseIni(readText(infoFile)) : {};
  const title = String(info.title || '').trim();
  const authors = asList(info.authors).map(String);
  const authorTxt = find('_author', ['txt']);
  if (!authors.length && authorTxt) authors.push(readText(authorTxt).trim());
  let icon = null;
  if (info.icon) icon = files.find((f) => f === info.icon) || find(info.icon, IMAGE_EXT);
  icon = icon || find('_icon', IMAGE_EXT) || find('_pack_filler_image', IMAGE_EXT);
  const filler = find('_pack_filler_image', IMAGE_EXT) || find('_icon', IMAGE_EXT);

  const clips = [];
  const audio = files
    .filter((f) => AUDIO_EXT.includes(ext(f)) && !RESERVED_AUDIO.some((r) => base(f).toLowerCase().startsWith(r)))
    .sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0));
  for (const f of audio) {
    const id = base(f);
    let cfg = {};
    let caption = '';
    const ini = find(id, ['ini', 'cfg']);
    const txt = find(id, ['txt']);
    if (ini) cfg = parseIni(readText(ini));
    if (txt) {
      const t = readText(txt);
      if (t.trim().startsWith('[data]')) { if (!ini) cfg = parseIni(t); } else caption = t.trim();
    }
    if (!caption) caption = String(cfg.caption || '').trim();
    let image = null;
    if (cfg.image) image = files.find((x) => x === cfg.image) || find(cfg.image, IMAGE_EXT);
    image = image || find(id, IMAGE_EXT) || filler || null;
    clips.push({
      id,
      audio: f,
      image,
      caption,
      chars: asList(cfg.dub_characters).map((c) => String(c).trim()).filter(Boolean),
      times: asList(cfg.dub_timestamps).map(Number).filter((x) => Number.isFinite(x)),
      dubOnly: !!cfg.dub_only,
      duration: audioDuration(path.join(dir, f)),
    });
  }
  const video = ['ogv', 'mp4', 'webm', 'mkv', 'mov'].map((e) => find('dub_video', [e])).find(Boolean) || null;
  const backing = find('_backing_track', AUDIO_EXT);
  return { title, subtitle: String(info.subtitle || ''), authors, readme: String(info.readme || ''), icon, video, backing, clips };
}

/** Reihenfolge wie im Spiel wählbar: chrono (wie im Video), file (Dateiname), character (nach Figur), random. */
export function orderClips(clips, mode) {
  const list = [...clips];
  const first = (c) => (c.times.length ? Math.min(...c.times) : 1e9);
  if (mode === 'chrono') list.sort((a, b) => first(a) - first(b));
  else if (mode === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  } else if (mode === 'character') {
    const chars = [];
    for (const c of clips) for (const ch of c.chars) if (!chars.includes(ch)) chars.push(ch);
    const key = (c) => (c.chars.length ? chars.indexOf(c.chars[0]) : chars.length);
    list.sort((a, b) => key(a) - key(b) || (a.audio < b.audio ? -1 : 1));
  }
  return list.map((c) => c.id);
}
