/* Nutzungsstatistik: nur Zählerstände pro Tag (keine Namen, keine Adressen).
 *   rooms      neue Räume
 *   shows      gestartete Gameshows
 *   dubs       gestartete Dub-Runden
 *   players    Beitritte (Handy, Browser, PC mit Mod)
 *   exports    exportierte Dub-Videos
 * Datei: STATS_DIR/stats.json, wird jede Minute und beim Beenden geschrieben.
 *
 * Anzeigen (auf dem Server):  docker exec voicigame node src/stats.js [Tage]   (Standard 30)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = process.env.STATS_DIR || path.join(os.tmpdir(), 'voicigame-stats');
const FILE = path.join(DIR, 'stats.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

let data = null;
let dirty = false;

/** Zähler für heute erhöhen. */
export function count(key, n = 1) {
  data ??= load();
  const day = new Date().toISOString().slice(0, 10);
  const d = (data[day] ??= {});
  d[key] = (d[key] || 0) + n;
  dirty = true;
}

/** Auf die Platte schreiben (erst neue Datei, dann umbenennen: nie eine halbe Datei). */
export function flush() {
  if (!dirty || !data) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (e) {
    console.error('Statistik nicht gespeichert:', e.message);
  }
}

export function startAutoFlush() {
  setInterval(flush, 60_000).unref();
}

/* ---------- Anzeige als Balkendiagramm ---------- */

function show(days) {
  const all = load();
  const today = new Date();
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const v = all[key] || {};
    rows.push({ d, key, shows: v.shows || 0, dubs: v.dubs || 0, players: v.players || 0, rooms: v.rooms || 0, exports: v.exports || 0 });
  }
  const games = (r) => r.shows + r.dubs;
  const max = Math.max(1, ...rows.map(games));
  const WIDTH = 40;
  const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const out = [`Voicigame, letzte ${days} Tage (${rows[0].key} bis ${rows[rows.length - 1].key}, UTC)`, ''];
  out.push('Tag        Spiele (█ Gameshow, ▒ Dub)');
  for (const r of rows) {
    const a = Math.round((r.shows / max) * WIDTH), b = Math.round((r.dubs / max) * WIDTH);
    const bar = '█'.repeat(a) + '▒'.repeat(b);
    const extra = games(r) || r.players ? `  ${r.players} Spieler, ${r.rooms} Räume` : '';
    out.push(`${r.key.slice(5)} ${wd[r.d.getUTCDay()]}  ${bar.padEnd(WIDTH)} ${String(games(r)).padStart(4)}${extra}`);
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const total = sum('shows') + sum('dubs');
  const active = rows.filter((r) => games(r) > 0).length;
  out.push('');
  out.push(`Summe: ${total} Spiele (${sum('shows')} Gameshows, ${sum('dubs')} Dub-Runden), ${sum('players')} Spieler, ${sum('rooms')} Räume, ${sum('exports')} Videos exportiert`);
  out.push(`Tage mit Spielen: ${active} von ${days}, im Schnitt ${(total / days).toFixed(1)} Spiele pro Tag`);
  console.log(out.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const days = Math.max(1, Math.min(3650, parseInt(process.argv[2], 10) || 30));
  show(days);
}
