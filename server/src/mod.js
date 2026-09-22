/* Mod-Dateien für den Auto-Updater des Mods (mod/voicigame/updater.gd).
 *   GET /api/mod         Version (aus main.gd) und je Datei Name, Größe, SHA-256
 *                        ?v=<Version>&os=<System>: für die Statistik, welche Mod-Versionen unterwegs sind
 *   GET /api/mod/<Datei> die Datei selbst (nur Dateien aus der Liste)
 * Ordner: MOD_DIR, sonst ../../mod/voicigame (Repo). Fehlt er, gibt es einfach keine Updates. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, tag } from './stats.js';

const MOD_DIR = process.env.MOD_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'mod', 'voicigame');

function readManifest() {
  const names = fs.readdirSync(MOD_DIR).filter((n) => n.endsWith('.gd') || n === 'lang.json').sort();
  const main = fs.readFileSync(path.join(MOD_DIR, 'main.gd'), 'utf8');
  const version = /const VERSION := "([^"]+)"/.exec(main)?.[1];
  if (!version) throw new Error('keine VERSION in main.gd');
  const files = names.map((name) => {
    const b = fs.readFileSync(path.join(MOD_DIR, name));
    return { name, size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
  });
  return { version, files };
}

export function installMod(app) {
  let manifest = null;
  try {
    manifest = readManifest();
    console.log(`Mod ${manifest.version} für Updates bereit (${manifest.files.length} Dateien)`);
  } catch (e) {
    console.log('Keine Mod-Dateien für Updates:', e.message);
  }
  app.get('/api/mod', (req, res) => {
    // Für die Statistik: welche Version fragt (?v=) und auf welchem System (?os=). Nur Zahlen, keine Adressen.
    count('mod_check');
    if (req.query.v) tag('mod', req.query.v);
    if (req.query.os) tag('os', req.query.os);
    if (!manifest) return res.status(404).json({ error: 'no_mod' });
    res.set('Cache-Control', 'no-cache').json(manifest);
  });
  app.get('/api/mod/:name', (req, res) => {
    const f = manifest?.files.find((x) => x.name === req.params.name);
    if (!f) return res.status(404).json({ error: 'not_found' });
    count('mod_file');
    res.set('Content-Type', 'application/octet-stream').sendFile(path.join(MOD_DIR, f.name));
  });
}
