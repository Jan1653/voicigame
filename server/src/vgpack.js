/* Voicigame-Pack (.vgpack): ein Pack in einer Datei, fertig für den Browser.
 *
 * Gebaut wird es auf dem PC, der das Pack hat (mod/voicigame/pack_web.gd, mit ffmpeg). Der Server
 * bekommt es fertig und rechnet nichts mehr: Video als H.264-MP4, Ton als AAC, Bilder klein.
 * Das spart auf dem Server die teuerste Arbeit und auf der Leitung den größten Teil der Daten
 * (Theora und WAV sind ein Vielfaches davon).
 *
 * Aufbau:
 *   0..5    "VGPACK"
 *   6       Version (1)
 *   7       "\n"
 *   8..11   Länge des Verzeichnisses (u32 LE)
 *   12..    Verzeichnis als JSON
 *   danach  die Dateien am Stück, in der Reihenfolge des Verzeichnisses
 *
 * Verzeichnis: {v, fp, src, assets: [{n, o, l, m, d}]}
 *   n Name der Originaldatei (darüber wird gesucht), o Anfang, l Länge, m Typ, d Länge in Sekunden
 *
 * Die Datei kommt in Stücken an. Was schon da ist, lässt sich sofort ausliefern: alles, was vor
 * der Marke „so viele Bytes sind da“ endet.
 */
import fs from 'node:fs';

export const MAGIC = 'VGPACK';
export const HEAD = 12;
const MAX_MANIFEST = 4 * 1024 * 1024;

/** Verzeichnis aus den ersten Bytes lesen. -> {manifest, end} oder null, wenn noch zu wenig da ist. */
export function readManifest(buf) {
  if (buf.length < HEAD) return null;
  if (buf.toString('latin1', 0, 6) !== MAGIC) throw new Error('Keine .vgpack-Datei.');
  if (buf[6] !== 1) throw new Error('Diese .vgpack-Version kennt der Server nicht.');
  const len = buf.readUInt32LE(8);
  if (len > MAX_MANIFEST) throw new Error('Das Verzeichnis im Pack ist zu groß.');
  if (buf.length < HEAD + len) return null;
  let m;
  try {
    m = JSON.parse(buf.toString('utf8', HEAD, HEAD + len));
  } catch {
    throw new Error('Das Verzeichnis im Pack ist beschädigt.');
  }
  if (!m || !Array.isArray(m.assets)) throw new Error('Im Pack fehlt das Verzeichnis.');
  return { manifest: m, end: HEAD + len };
}

/** Verzeichnis aus einer Datei lesen (die ersten Bytes reichen). */
export function manifestOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, HEAD + MAX_MANIFEST));
    fs.readSync(fd, head, 0, head.length, 0);
    return readManifest(head);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Verzeichnis prüfen und in eine Map packen. Alles, was nicht stimmt, fliegt raus:
 * Namen ohne Pfadteile, Bereiche innerhalb der Datei, keine Überschneidung mit dem Verzeichnis.
 * -> Map Name -> {o, l, m, d}
 */
export function assetsOf(manifest, headEnd, size) {
  const out = new Map();
  for (const a of manifest.assets.slice(0, 20000)) {
    const n = String(a?.n || '');
    const o = Number(a?.o);
    const l = Number(a?.l);
    if (!n || /[\\/\u0000-\u001f]/.test(n) || n.length > 200) continue;
    if (!Number.isInteger(o) || !Number.isInteger(l) || l < 0 || o < headEnd || o + l > size) continue;
    out.set(n, { o, l, m: String(a?.m || 'application/octet-stream').slice(0, 60), d: Number(a?.d) || 0 });
  }
  return out;
}
