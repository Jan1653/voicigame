/* Packs merken, damit dieselbe Arbeit nicht zweimal anfällt.
 *
 * Ein Pack wird am Fingerabdruck erkannt (Dateinamen und Größen, siehe fileInfoOf in dub.js). Ist es
 * schon einmal hier gewesen, gilt beim nächsten Mal:
 *   - der PC lädt nichts mehr hoch
 *   - das Video wird nicht noch einmal umgewandelt (das ist die teuerste Arbeit auf dem Server)
 *   - jeder Export kopiert das Video nur noch
 *
 * Gespeichert wird in <DATA_DIR>/_packs/<Fingerabdruck>/. Dateien werden verlinkt (hardlink), wo das geht:
 * dann liegt jede Datei nur einmal auf der Platte, egal in wie vielen Räumen das Pack gerade läuft.
 * Der Ordner bleibt unter PACK_CACHE_GB; ist er voll, fliegt das am längsten ungenutzte Pack raus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { count as countStat } from './stats.js';

const MAX_BYTES = (Number(process.env.PACK_CACHE_GB) || 2) * 1024 ** 3;
const STAMP = '.used';

const dirOf = (dataDir, fp) => path.join(dataDir, '_packs', fp);

/** Liegt dieses Pack schon hier? fp: Fingerabdruck, files: [{name, size}] wie angekündigt. */
export function has(dataDir, fp, files) {
  if (!fp || !files?.length) return false;
  const dir = dirOf(dataDir, fp);
  for (const f of files) {
    try {
      if (fs.statSync(path.join(dir, 'pack', f.name)).size !== f.size) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Pack aus dem Speicher in den Raum holen. -> {video} (umgewandeltes Video oder null) */
export function take(dataDir, fp, packDir, webDir) {
  const dir = dirOf(dataDir, fp);
  fs.mkdirSync(packDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(dir, 'pack'))) {
    copyOrLink(path.join(dir, 'pack', name), path.join(packDir, name));
  }
  let video = null;
  const cached = path.join(dir, 'video.mp4');
  if (fs.existsSync(cached)) {
    fs.mkdirSync(webDir, { recursive: true });
    video = path.join(webDir, 'video.mp4');
    copyOrLink(cached, video);
  }
  touch(dir);
  countStat('pack_cache_hits');
  return { video };
}

/** Pack aufnehmen (nach dem Hochladen). video: umgewandeltes Video oder null. */
export function store(dataDir, fp, packDir, video) {
  if (!fp) return;
  const dir = dirOf(dataDir, fp);
  try {
    if (!fs.existsSync(path.join(dir, 'pack'))) {
      fs.mkdirSync(path.join(dir, 'pack'), { recursive: true });
      for (const name of fs.readdirSync(packDir)) {
        const src = path.join(packDir, name);
        if (fs.statSync(src).isFile()) copyOrLink(src, path.join(dir, 'pack', name));
      }
    }
    if (video && fs.existsSync(video) && !fs.existsSync(path.join(dir, 'video.mp4'))) {
      copyOrLink(video, path.join(dir, 'video.mp4'));
    }
    touch(dir);
    prune(dataDir);
  } catch (e) {
    console.warn('Pack nicht gemerkt:', e.message);
  }
}

/** Nur das umgewandelte Video nachtragen (es entsteht oft erst nach dem Hochladen). */
export function storeVideo(dataDir, fp, video) {
  if (!fp || !video) return;
  const dir = dirOf(dataDir, fp);
  if (!fs.existsSync(path.join(dir, 'pack'))) return;
  try {
    if (!fs.existsSync(path.join(dir, 'video.mp4'))) copyOrLink(video, path.join(dir, 'video.mp4'));
    touch(dir);
    prune(dataDir);
  } catch (e) {
    console.warn('Video nicht gemerkt:', e.message);
  }
}

function copyOrLink(src, dest) {
  try {
    fs.linkSync(src, dest);   // dieselbe Datei, kein zweiter Platz auf der Platte
  } catch {
    fs.copyFileSync(src, dest);
  }
}

function touch(dir) {
  try { fs.writeFileSync(path.join(dir, STAMP), String(Date.now())); } catch {}
}

function used(dir) {
  try { return Number(fs.readFileSync(path.join(dir, STAMP), 'utf8')) || 0; } catch { return 0; }
}

function size(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else try { n += fs.statSync(p).size; } catch {}
    }
  };
  try { walk(dir); } catch {}
  return n;
}

/** Über der Grenze: das am längsten ungenutzte Pack fliegt raus. */
export function prune(dataDir) {
  const root = path.join(dataDir, '_packs');
  let list;
  try { list = fs.readdirSync(root); } catch { return; }
  const packs = list.map((fp) => ({ fp, dir: path.join(root, fp), at: used(path.join(root, fp)), bytes: size(path.join(root, fp)) }));
  let total = packs.reduce((n, p) => n + p.bytes, 0);
  packs.sort((a, b) => a.at - b.at);
  for (const p of packs) {
    if (total <= MAX_BYTES) break;
    fs.rmSync(p.dir, { recursive: true, force: true });
    total -= p.bytes;
    countStat('pack_cache_drops');
  }
}
