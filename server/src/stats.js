/* Nutzungsstatistik: nur Zahlen pro Tag, nichts über einzelne Leute.
 * Keine Namen, keine Adressen, keine Raumcodes, keine Pack- oder Clip-Titel.
 * Alles ist eine Summe über alle: man sieht, dass 40 Leute auf Deutsch gespielt haben,
 * nicht wer davon wer war.
 *
 * Vier Arten von Werten, je Tag (UTC):
 *   count(key, n)        Zähler: Räume, Spiele, Aufnahmen, abgewiesene Anfragen, Fehler …
 *   peak(key, wert)      Höchststand des Tages: gleichzeitige Räume, Spieler, Verzögerung …
 *   observe(key, wert)   Verteilung: Anzahl, Summe, kleinster/größter Wert und grobe Klassen,
 *                        damit man sieht, wie lang eine Runde ungefähr ist.
 *   tag(gruppe, wert)    Aufteilung nach Art: Mod-Version, Sprache, Zeitzone, Browser …
 *
 * Datei: STATS_DIR/stats.json, wird jede Minute und beim Beenden geschrieben.
 * Anzeigen (auf dem Server):  docker exec -t voicigame node src/stats.js [Tage] [--json] [--no-color]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = process.env.STATS_DIR || path.join(os.tmpdir(), 'voicigame-stats');
const FILE = path.join(DIR, 'stats.json');

/** Klassen der Verteilungen. Ein Wert unter der ersten Grenze landet in der ersten Klasse,
 *  ab der letzten Grenze in der letzten. Werden Grenzen geändert, fangen die Klassen neu an. */
const BUCKETS = {
  show_min: [2, 5, 10, 15, 20, 30, 45, 60],
  dub_min: [2, 5, 10, 15, 20, 30, 45, 60],
  room_min: [2, 5, 10, 20, 30, 60, 90, 120],
  player_min: [1, 2, 5, 10, 20, 30, 45, 60],
  room_players: [2, 3, 4, 5, 6, 8, 12, 16],
  show_rounds: [2, 3, 5, 8, 12, 16, 24, 32],
  dub_lines: [5, 10, 20, 40, 60, 100, 150, 250],
  pack_lines: [5, 10, 20, 40, 60, 100, 150, 250],
  pack_mb: [10, 25, 50, 100, 200, 400, 600, 800],
  video_min: [1, 2, 3, 5, 8, 12, 20, 30],
  take_s: [1, 2, 3, 5, 8, 12, 20, 30],
  upload_s: [1, 2, 3, 5, 8, 15, 30, 60],
  queue_s: [5, 10, 30, 60, 120, 300, 600, 1200],
};

/** Höchstens so viele verschiedene Werte je Gruppe und Tag. Alles Weitere wird „andere“:
 *  Sprache, Zeitzone und Version kommen vom Client, die Datei soll davon nicht volllaufen. */
const MAX_TAGS = 120;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

let data = null;
let dirty = false;

const r3 = (x) => Math.round(x * 1000) / 1000;

function day() {
  data ??= load();
  return (data[new Date().toISOString().slice(0, 10)] ??= {});
}

/** Zähler für heute erhöhen. */
export function count(key, n = 1) {
  if (!Number.isFinite(n)) return;
  const d = day();
  d[key] = r3((d[key] || 0) + n);
  dirty = true;
}

/** Höchststand des Tages festhalten (nur wenn größer als bisher). */
export function peak(key, value) {
  if (!Number.isFinite(value)) return;
  const m = (day().max ??= {});
  if (!(value <= m[key])) {
    m[key] = r3(value);
    dirty = true;
  }
}

/** Einzelmessung in die Verteilung eintragen (Dauer in Minuten/Sekunden oder eine Anzahl). */
export function observe(key, value) {
  if (!Number.isFinite(value) || value < 0) return;
  const all = (day().dist ??= {});
  const edges = BUCKETS[key] || [];
  const v = r3(value);
  const e = (all[key] ??= { n: 0, sum: 0, min: v, max: v, b: [] });
  e.n++;
  e.sum = r3(e.sum + value);
  e.min = Math.min(e.min, v);
  e.max = Math.max(e.max, v);
  if (edges.length) {
    if (e.b?.length !== edges.length + 1) e.b = new Array(edges.length + 1).fill(0);
    let i = edges.findIndex((x) => value < x);
    if (i < 0) i = edges.length;
    e.b[i]++;
  }
  dirty = true;
}

/** Nach Art aufteilen, z. B. tag('lang', 'de') oder tag('mod', '0.5.0').
 *  Werte kommen teils vom Client: kurz halten, säubern, Anzahl begrenzen. */
export function tag(group, value, n = 1) {
  const v = String(value ?? '').trim().replace(/[^\w.:/+-]/g, '_').slice(0, 40);
  if (!v || !Number.isFinite(n)) return;
  const g = ((day().tags ??= {})[group] ??= {});
  const key = g[v] === undefined && Object.keys(g).length >= MAX_TAGS ? 'andere' : v;
  g[key] = (g[key] || 0) + n;
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

/** Für die Anzeige (statsview.js): alle Tage aus der Datei und die Klassengrenzen. */
export function readAll() {
  return load();
}
export { BUCKETS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const days = Math.max(1, Math.min(3650, parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 30));
  // Erst laden, wenn diese Datei fertig ist: statsview.js holt sich von hier die Klassengrenzen
  import('./statsview.js').then(({ report }) => {
    // Farben nur im Terminal, nicht in einer Datei oder Pipe
    const color = !args.includes('--no-color') && !!process.stdout.isTTY;
    console.log(report(readAll(), days, { json: args.includes('--json'), color }));
  });
}
