/* Fehler und Warnungen sammeln, damit man nachsehen kann, was schiefging.
 *   - alles, was der Server auf console.error oder console.warn schreibt
 *   - unerwartete Fehler (uncaughtException, unhandledRejection)
 *   - Fehler aus den Browsern der Spieler und aus dem Mod im Spiel (POST /api/log, siehe server.js)
 *
 * Geschrieben wird in STATS_DIR/log.txt, also neben die Statistik und damit über Updates hinweg.
 * Ab 1 MB wandert die Datei nach log.1.txt, es bleiben also höchstens zwei.
 * Inhalt: Zeitpunkt, Art und Text. Keine Namen, keine Adressen, keine Raumcodes.
 *
 * Anzeigen (auf dem Server):  docker exec voicigame node src/errlog.js [Zeilen]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { count } from './stats.js';

const DIR = process.env.STATS_DIR || path.join(os.tmpdir(), 'voicigame-stats');
const FILE = path.join(DIR, 'log.txt');
const OLD = path.join(DIR, 'log.1.txt');
const MAX_BYTES = 1024 * 1024;
const MAX_LINE = 1000;

let size = -1;

/** Eine Zeile anhängen. kind: error | warn | web | mod. */
export function write(kind, text) {
  const line = `${new Date().toISOString()} ${kind} ${String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_LINE)}\n`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (size < 0) size = fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
    if (size + line.length > MAX_BYTES) {
      fs.rmSync(OLD, { force: true });
      fs.renameSync(FILE, OLD);
      size = 0;
    }
    fs.appendFileSync(FILE, line);
    size += line.length;
  } catch {
    // Kein Platz oder kein Schreibrecht: der Server läuft trotzdem weiter
  }
}

/** Meldung von einem Spieler: aus dem Browser oder aus dem Mod im Spiel.
 *  Kommt über /api/log, dort auch die Bremse gegen zu viele Meldungen. */
export function fromClient(text, where, kind = 'web') {
  count(kind === 'mod' ? 'errors_mod' : 'errors_web');
  write(kind === 'mod' ? 'mod' : 'web', `${where ? where + ' | ' : ''}${text}`);
}

/** Wie fromClient, für die Browser. */
export function fromWeb(text, where) {
  fromClient(text, where, 'web');
}

/** console.error und console.warn mitschreiben und zählen. Einmal beim Start aufrufen. */
export function install() {
  const err = console.error.bind(console);
  const warn = console.warn.bind(console);
  console.error = (...a) => {
    count('errors');
    write('error', a.map(fmt).join(' '));
    err(...a);
  };
  console.warn = (...a) => {
    count('warnings');
    write('warn', a.map(fmt).join(' '));
    warn(...a);
  };
}

function fmt(x) {
  if (x instanceof Error) return `${x.message} ${(x.stack || '').split('\n')[1] || ''}`;
  if (typeof x === 'object') {
    try { return JSON.stringify(x); } catch { return String(x); }
  }
  return String(x);
}

/** Die letzten Zeilen ausgeben (CLI). */
function show(n) {
  let lines = [];
  for (const f of [OLD, FILE]) {
    try { lines = lines.concat(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch {}
  }
  if (!lines.length) return console.log('Noch nichts protokolliert.');
  for (const l of lines.slice(-n)) console.log(l);
  console.log(`\n${lines.length} Zeilen insgesamt, Datei: ${FILE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) show(Number(process.argv[2]) || 50);
