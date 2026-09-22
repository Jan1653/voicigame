/* Bericht aus der Nutzungsstatistik fürs Terminal.
 *   docker exec voicigame node src/stats.js [Tage] [--json] [--no-color]
 * Die Zahlen sammelt stats.js, hier werden sie nur gerechnet und gesetzt. */
import { BUCKETS } from './stats.js';

const WIDTH = Math.max(72, Math.min(104, Number(process.env.STATS_WIDTH) || process.stdout.columns || 80)) - 1;
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/* ---------- Farben und Zahlen ---------- */

let c = {};
function setColor(on) {
  const e = (code) => (on ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s));
  c = { bold: e(1), dim: e(2), head: e('1;36'), bar: e(36), warn: e(33), bad: e(31), ok: e(32) };
}

/** Sichtbare Länge (ohne Farbcodes). */
const vis = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - vis(s)));
/** Auf n Zeichen kürzen (nur für Text ohne Farbcodes). */
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, Math.max(1, n - 1)) + '…' : String(s));
const padL = (s, n) => ' '.repeat(Math.max(0, n - vis(s))) + String(s);

/** 1234567 -> 1.234.567 */
function int(x) {
  const n = Math.round(Math.abs(Number(x) || 0));
  return (Number(x) < 0 ? '-' : '') + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Komma statt Punkt, ohne überflüssige Nullen (kein Intl: fehlt in manchen Node-Images). */
function num(x, k = 1) {
  if (!Number.isFinite(x)) return '–';
  let s = (Math.round(x * 10 ** k) / 10 ** k).toFixed(k);
  if (k) s = s.replace(/\.?0+$/, '');
  const [a, b] = s.split('.');
  return int(a) + (b ? ',' + b : '');
}

/** Minuten lesbar: 0,8 -> 48 s, 12,4 -> 12,4 Min, 140 -> 2,3 Std */
function dur(min) {
  if (!Number.isFinite(min)) return '–';
  if (min < 1) return `${Math.round(min * 60)} s`;
  if (min < 90) return `${num(min)} Min`;
  if (min < 48 * 60) return `${num(min / 60)} Std`;
  return `${num(min / 1440)} Tage`;
}

/** Einzahl oder Mehrzahl: pl(1, 'Raum', 'Räume') -> „1 Raum“ */
const pl = (n, one, many) => `${int(n)} ${Math.round(n) === 1 ? one : many}`;
const size = (mb) => (mb >= 1024 ? `${num(mb / 1024)} GB` : `${num(mb)} MB`);
const pct = (part, all) => (!all ? '0 %' : part / all >= 0.01 || part === 0 ? `${Math.round((part / all) * 100)} %` : '<1 %');

/* ---------- Klartext für Kürzel ---------- */

const LANGS = {
  de: 'Deutsch', en: 'Englisch', es: 'Spanisch', fr: 'Französisch', pt: 'Portugiesisch', it: 'Italienisch',
  ru: 'Russisch', pl: 'Polnisch', tr: 'Türkisch', nl: 'Niederländisch', uk: 'Ukrainisch', id: 'Indonesisch',
  ja: 'Japanisch', zh: 'Chinesisch', ko: 'Koreanisch', hi: 'Hindi', cs: 'Tschechisch', sk: 'Slowakisch',
  sr: 'Serbisch', sv: 'Schwedisch', da: 'Dänisch', ro: 'Rumänisch', hu: 'Ungarisch', el: 'Griechisch',
  vi: 'Vietnamesisch', th: 'Thailändisch',
};

const LANDS = {
  DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', US: 'USA', GB: 'Großbritannien', FR: 'Frankreich',
  NL: 'Niederlande', BE: 'Belgien', PL: 'Polen', CZ: 'Tschechien', SK: 'Slowakei', HU: 'Ungarn',
  IT: 'Italien', ES: 'Spanien', PT: 'Portugal', BR: 'Brasilien', MX: 'Mexiko', AR: 'Argentinien',
  SE: 'Schweden', NO: 'Norwegen', DK: 'Dänemark', FI: 'Finnland', IS: 'Island', IE: 'Irland',
  RU: 'Russland', UA: 'Ukraine', BY: 'Belarus', RO: 'Rumänien', BG: 'Bulgarien', GR: 'Griechenland',
  RS: 'Serbien', HR: 'Kroatien', SI: 'Slowenien', TR: 'Türkei', IL: 'Israel', IN: 'Indien',
  CN: 'China', JP: 'Japan', KR: 'Südkorea', TW: 'Taiwan', TH: 'Thailand', VN: 'Vietnam',
  ID: 'Indonesien', PH: 'Philippinen', MY: 'Malaysia', SG: 'Singapur', AU: 'Australien', NZ: 'Neuseeland',
  CA: 'Kanada', ZA: 'Südafrika', EG: 'Ägypten', AE: 'Vereinigte Arabische Emirate', SA: 'Saudi-Arabien',
  CL: 'Chile', CO: 'Kolumbien', PE: 'Peru', LT: 'Litauen', LV: 'Lettland', EE: 'Estland', LU: 'Luxemburg',
};

const STYLES = { aero: 'Spiel-Stil', simple: 'Schlicht hell', dark: 'Schlicht dunkel' };
const PICKS = { selbst: 'selbst ausgesucht', geraet: 'Sprache des Geräts' };
const CLIENTS = { web: 'Website (Handy/Browser)', game: 'Eigenes Spiel mit Mod' };

const nameOf = (map) => (k) => (map[k] ? `${map[k]} ${c.dim(`(${k})`)}` : k);
const plain = (k) => k;

/* ---------- Bausteine ---------- */

function box(out, title, sub) {
  const w = WIDTH - 2;
  out.push(c.dim('┌' + '─'.repeat(w) + '┐'));
  out.push(c.dim('│') + ' ' + padR(c.bold(clip(title, w - 2)), w - 1) + c.dim('│'));
  if (sub) out.push(c.dim('│') + ' ' + padR(c.dim(clip(sub, w - 2)), w - 1) + c.dim('│'));
  out.push(c.dim('└' + '─'.repeat(w) + '┘'));
}

function head(out, title, right = '') {
  const name = title.toUpperCase();
  // Der Hinweis rechts fällt weg, wenn die Zeile dafür zu schmal ist
  const fits = right && WIDTH - 4 - name.length - right.length >= 2;
  out.push('');
  out.push('  ' + (fits ? padR(c.head(name), WIDTH - 4 - right.length) + c.dim(right) : c.head(name)));
  out.push('  ' + c.dim('─'.repeat(WIDTH - 4)));
}

function kv(out, label, value) {
  out.push('  ' + padR(label, 22) + value);
}

/** Zeile mit ausgerichteter Zahl und Erklärung dahinter. */
function kvn(out, label, n, note = '') {
  out.push('  ' + padR(label, 22) + padL(c.bold(int(n)), 7) + (note ? '   ' + c.dim(note) : ''));
}

/** Liste mit Anteil und Balken, z. B. Sprachen oder Mod-Versionen. */
function ranked(out, obj, { rows = 8, label = plain } = {}) {
  const list = Object.entries(obj || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!list.length) return false;
  const all = list.reduce((s, x) => s + x[1], 0);
  const max = list[0][1];
  const bw = Math.max(8, WIDTH - 54);
  for (const [k, v] of list.slice(0, rows)) {
    out.push('    ' + padR(label(k), 32) + padL(int(v), 8) + padL(pct(v, all), 7) + '  '
      + c.bar('█'.repeat(Math.max(1, Math.round((v / max) * bw)))));
  }
  if (list.length > rows) {
    const rest = list.slice(rows).reduce((s, x) => s + x[1], 0);
    out.push('    ' + padR(c.dim(`… ${list.length - rows} weitere`), 32) + padL(c.dim(int(rest)), 8) + padL(c.dim(pct(rest, all)), 7));
  }
  return true;
}

/* ---------- Verteilungen ---------- */

function mergeDist(rows, key) {
  const out = { n: 0, sum: 0, min: Infinity, max: 0, b: [] };
  for (const r of rows) {
    const e = r.raw.dist?.[key];
    if (!e?.n) continue;
    out.n += e.n;
    out.sum += e.sum;
    out.min = Math.min(out.min, e.min);
    out.max = Math.max(out.max, e.max);
    (e.b || []).forEach((v, i) => (out.b[i] = (out.b[i] || 0) + v));
  }
  return out.n ? out : null;
}

/** Median aus den Klassen schätzen (innerhalb einer Klasse gleichmäßig verteilt gedacht). */
function median(e, edges) {
  if (!e?.n) return null;
  const b = e.b || [];
  if (!edges.length || b.length !== edges.length + 1) return e.sum / e.n;
  const half = e.n / 2;
  let seen = 0;
  for (let i = 0; i < b.length; i++) {
    if (seen + b[i] >= half) {
      const lo = i === 0 ? e.min : edges[i - 1];
      const hi = i === b.length - 1 ? e.max : edges[i];
      return Math.min(e.max, Math.max(e.min, lo + (hi - lo) * (b[i] ? (half - seen) / b[i] : 0)));
    }
    seen += b[i];
  }
  return e.max;
}

/** Beschriftung je Klasse. kind: 'min' Minuten, 's' Sekunden, 'mb' Megabyte, 'n' Anzahl */
function labels(edges, kind) {
  const u = { min: ' Min', s: ' s', mb: ' MB', n: '' }[kind] || '';
  const out = [];
  for (let i = 0; i <= edges.length; i++) {
    const lo = edges[i - 1];
    const hi = edges[i];
    if (i === 0) out.push(kind === 'n' ? (hi === 2 ? '1' : `bis ${hi - 1}`) : `unter ${hi}${u}`);
    else if (i === edges.length) out.push(`ab ${lo}${u}`);
    else if (kind === 'n') out.push(hi - lo === 1 ? String(lo) : `${lo} bis ${hi - 1}`);
    else out.push(`${lo} bis ${hi}${u}`);
  }
  return out;
}

const fmtOf = { min: dur, s: (x) => `${num(x)} s`, mb: (x) => size(x), n: (x) => num(x) };

/** Eine Verteilung: Kopfzeile mit Median/Schnitt, darunter die Klassen als Balken. */
function distBlock(out, title, e, key, kind) {
  if (!e?.n) return;
  const edges = BUCKETS[key] || [];
  const f = fmtOf[kind] || num;
  const line = '  ' + padR(c.bold(title), 22) + padL(int(e.n) + '×', 7)
    + `  Median ${padR(f(median(e, edges)), 9)} Ø ${padR(f(e.sum / e.n), 9)}`;
  const span = `von ${f(e.min)} bis ${f(e.max)}`;
  out.push(vis(line) + span.length <= WIDTH ? line + ' ' + c.dim(span) : line);
  const b = e.b || [];
  if (b.length !== edges.length + 1 || e.n < 3) return;
  const lab = labels(edges, kind);
  const max = Math.max(...b);
  const first = b.findIndex((v) => v > 0);
  const last = b.length - 1 - [...b].reverse().findIndex((v) => v > 0);
  const bw = Math.max(10, WIDTH - 50);
  for (let i = first; i <= last && max > 0; i++) {
    const bar = '█'.repeat(Math.round((b[i] / max) * bw));
    out.push('      ' + padR(c.dim(lab[i]), 18) + padL(int(b[i]), 6) + (bar ? '  ' + c.bar(bar) : ''));
  }
}

/* ---------- Bericht ---------- */

export function report(all, days, { json = false, color = true } = {}) {
  setColor(color && !process.env.NO_COLOR);
  const now = new Date();
  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    rows.push({ d, key, raw: all[key] || {} });
  }
  if (json) return JSON.stringify(Object.fromEntries(rows.map((r) => [r.key, r.raw])), null, 1);

  const v = (r, k) => r.raw[k] || 0;
  const sum = (k) => rows.reduce((s, r) => s + v(r, k), 0);
  const top = (k) => Math.max(0, ...rows.map((r) => r.raw.max?.[k] || 0));
  const dist = (k) => mergeDist(rows, k);
  const tags = (g) => {
    const out = {};
    for (const r of rows) for (const [k, n] of Object.entries(r.raw.tags?.[g] || {})) out[k] = (out[k] || 0) + n;
    return out;
  };
  const games = (r) => v(r, 'shows') + v(r, 'dubs');
  const out = [];

  box(out, 'Voicigame · Nutzungsstatistik',
    `letzte ${days} Tage · ${rows[0].key} bis ${rows[rows.length - 1].key} · UTC · nur Summen, keine Namen`);

  if (!rows.some((r) => Object.keys(r.raw).length)) {
    out.push('', '  Für diesen Zeitraum gibt es noch keine Zahlen.', '');
    return out.join('\n');
  }

  /* Balken je Tag (bei langen Zeiträumen wochenweise) */
  const weekly = days > 70;
  const chart = [];
  for (const r of rows) {
    const last = chart[chart.length - 1];
    const label = weekly ? `ab ${r.key.slice(5)}` : `${WD[r.d.getUTCDay()]} ${r.key.slice(5)}`;
    if (weekly && last && r.d.getUTCDay() !== 1 && chart.length) {
      last.shows += v(r, 'shows'); last.dubs += v(r, 'dubs');
      last.players += v(r, 'players'); last.rooms += v(r, 'rooms'); last.busy += v(r, 'busy_s');
      continue;
    }
    chart.push({ label, shows: v(r, 'shows'), dubs: v(r, 'dubs'), players: v(r, 'players'), rooms: v(r, 'rooms'), busy: v(r, 'busy_s') });
  }
  head(out, weekly ? 'Spiele pro Woche' : 'Spiele pro Tag', '█ Gameshow   ▒ Dub   ! überlastet');
  const cw = Math.max(12, WIDTH - 48);
  const cmax = Math.max(1, ...chart.map((r) => r.shows + r.dubs));
  for (const r of chart) {
    const g = r.shows + r.dubs;
    const dubBar = '▒'.repeat(Math.round((r.dubs / cmax) * cw));
    const bar = '█'.repeat(Math.round((r.shows / cmax) * cw)) + (dubBar ? c.dim(dubBar) : '');
    const extra = g || r.players
      ? c.dim(`${padL(int(r.players), 4)} Spieler  ${padL(int(r.rooms), 3)} ${Math.round(r.rooms) === 1 ? 'Raum ' : 'Räume'}`) : '';
    out.push('  ' + padR(c.dim(r.label), 10) + padR(bar ? c.bar(bar) : '', cw + 1) + padL(g ? int(g) : '·', 5) + '  ' + extra
      + (r.busy ? c.warn('  !') : ''));
  }

  /* Überblick */
  const total = sum('shows') + sum('dubs');
  const activeDays = rows.filter((r) => games(r) > 0).length;
  head(out, 'Überblick');
  kvn(out, 'Spiele', total, `${pl(sum('shows'), 'Gameshow', 'Gameshows')}, ${pl(sum('dubs'), 'Dub-Runde', 'Dub-Runden')}`);
  kvn(out, 'Räume', sum('rooms'), `${int(sum('rooms_game'))} aus dem Spiel, ${int(sum('rooms_web'))} im Browser`);
  kvn(out, 'Beitritte', sum('players'), `${int(sum('players_game'))} mit eigener Mod, ${int(sum('players_web'))} über die Website`);
  kvn(out, 'Tage mit Spielen', activeDays, `von ${days}, im Schnitt ${num(total / days)} Spiele pro Tag`);

  /* Wer spielt womit */
  const groups = [
    ['Wie sie mitspielen', 'client', nameOf(CLIENTS)],
    ['Mod-Version', 'mod', plain],
    ['Spielversion', 'gameversion', plain],
    ['System der Mod', 'os', plain],
    ['Browser', 'browser', plain],
    ['Gerät', 'system', plain],
    ['Stil der Website', 'style', nameOf(STYLES)],
  ].filter(([, g]) => Object.keys(tags(g)).length);
  if (groups.length) {
    head(out, 'Womit gespielt wird');
    for (const [title, g, label] of groups) {
      out.push('  ' + c.bold(title));
      ranked(out, tags(g), { label, rows: 8 });
    }
  }

  /* Woher */
  const origin = [
    ['Sprache der Website', 'lang', nameOf(LANGS)],
    ['Sprache kommt von', 'langpick', (k) => PICKS[k] || k],
    ['Zeitzone', 'zone', plain],
    ['Land (Einstellung im Browser)', 'land', nameOf(LANDS)],
  ].filter(([, g]) => Object.keys(tags(g)).length);
  if (origin.length) {
    head(out, 'Woher die Leute kommen', 'aus den Einstellungen des Geräts, nicht aus der Adresse');
    for (const [title, g, label] of origin) {
      out.push('  ' + c.bold(title));
      ranked(out, tags(g), { label, rows: 10 });
    }
  }

  /* Dauer und Menge */
  const blocks = [
    ['Gameshow', 'show_min', 'min'], ['Dub-Runde', 'dub_min', 'min'],
    ['Raum offen', 'room_min', 'min'], ['Jemand im Raum', 'player_min', 'min'],
    ['Spieler je Raum', 'room_players', 'n'], ['Runden je Gameshow', 'show_rounds', 'n'],
    ['Zeilen je Dub-Runde', 'dub_lines', 'n'], ['Zeilen je Pack', 'pack_lines', 'n'],
    ['Größe der Packs', 'pack_mb', 'mb'], ['Länge des Dub-Videos', 'video_min', 'min'],
    ['Länge einer Aufnahme', 'take_s', 's'], ['Aufnahme unterwegs', 'upload_s', 's'],
  ].filter(([, k]) => dist(k));
  if (blocks.length) {
    head(out, 'Wie lang und wie viel', 'Balken: so viele Fälle je Klasse');
    for (const [title, key, kind] of blocks) distBlock(out, title, dist(key), key, kind);
  }

  /* Aufnahmen und Dateien */
  head(out, 'Aufnahmen und Dateien');
  kvn(out, 'Aufnahmen', sum('takes'), `${size(sum('take_mb'))}, aus ${pl(sum('rounds'), 'Gameshow-Runde', 'Gameshow-Runden')} und ${pl(sum('lines'), 'Dub-Zeile', 'Dub-Zeilen')}`);
  kvn(out, 'Clips vom Spiel', sum('clips'), size(sum('clip_mb')));
  kvn(out, 'Dub-Packs', sum('packs'), size(dist('pack_mb')?.sum || 0));
  kvn(out, 'Videos exportiert', sum('exports'), `${int(sum('export_fail'))} fehlgeschlagen, ${int(sum('zips'))}× Aufnahmen als ZIP`);
  kvn(out, 'Live-Bild', sum('watch'), 'mal eingeschaltet');
  kvn(out, 'Mod-Updater', sum('mod_check'), `Anfragen, ${int(sum('mod_file'))} Dateien geladen`);

  /* Server */
  const busyDays = rows.filter((r) => v(r, 'busy_s') > 0).length;
  const wait = dist('queue_s');
  const busy = sum('busy_s');
  const errs = sum('errors');
  head(out, 'Server');
  kv(out, 'Überlastet', (busy ? c.warn(dur(busy / 60)) : c.ok('nie'))
    + `   ${c.dim(`an ${busyDays} von ${days} Tagen, höchste Verzögerung ${int(top('lag_ms'))} ms`)}`);
  kv(out, 'Warteschlange', `${pl(sum('queued'), 'Raum musste', 'Räume mussten')} warten   `
    + c.dim(`längste Schlange ${int(top('queue'))}`));
  if (wait) kv(out, 'Wartezeit', `Median ${num(median(wait, BUCKETS.queue_s))} s   ${c.dim(`längste ${num(wait.max)} s`)}`);
  kv(out, 'Abgewiesen', `${int(sum('rate_limited'))}× zu viele Räume je Adresse, ${int(sum('full_room'))}× Raum voll, ${int(sum('full_storage'))}× Speicher voll`);
  kv(out, 'Höchststände', `${pl(top('rooms'), 'Raum', 'Räume')} ${c.dim(`(${int(top('active'))} in Benutzung)`)}, ${int(top('players'))} Spieler, ${int(top('watchers'))} Zuschauer`);
  kv(out, 'Platz und RAM', `${size(top('storage_mb'))} Dateien, ${size(top('rss_mb'))} Arbeitsspeicher ${c.dim('(Höchststand)')}`);
  const warns = sum('warnings');
  const webErrs = sum('errors_web');
  kv(out, 'Fehler im Log', (errs ? c.bad(int(errs)) : c.ok('0')) + c.dim(`   ${int(warns)} Warnungen, ${int(webErrs)} aus Browsern`)
    + c.dim('   (node src/errlog.js)'));
  out.push('');
  return out.map((l) => l.replace(/\s+$/, '')).join('\n');
}
