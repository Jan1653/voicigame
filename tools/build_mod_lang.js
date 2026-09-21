// Übersetzungen für den Mod (mod/voicigame/lang.json) zusammenstellen.
// Sucht alle übersetzbaren Texte in den .gd-Dateien (I18n.t("…") und tr_("…")) und nimmt die
// Übersetzung aus lang.json, sonst aus den Übersetzungen der Webseite (server/public/lang).
// Meldet, welche Texte noch in keiner Sprache übersetzt sind.
//   node tools/build_mod_lang.js            schreibt lang.json
//   node tools/build_mod_lang.js --check    nur prüfen, Rückgabewert 1 bei Lücken
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'mod', 'voicigame');
const WEB = path.join(ROOT, 'server', 'public', 'lang');
const MAIN = ['en', 'es', 'fr', 'pt', 'it'];

// Webseiten-Übersetzungen laden (dieselben Dateien, die der Browser lädt)
const ctx = { window: {} };
vm.createContext(ctx);
const web = {};
if (fs.existsSync(path.join(WEB, 'strings.js'))) {
  vm.runInContext(fs.readFileSync(path.join(WEB, 'strings.js'), 'utf8'), ctx);
  for (const code of ctx.window.VG_LANG_FILES || []) {
    const f = path.join(WEB, `${code}.js`);
    if (fs.existsSync(f)) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx);
  }
  for (const row of ctx.window.VG_STRINGS || []) {
    MAIN.forEach((code, i) => { if (row[i + 1]) (web[code] ??= {})[row[0]] = row[i + 1]; });
  }
  for (const [code, pack] of Object.entries(ctx.window.VG_LANG || {})) web[code] = { ...pack.strings };
}
const langs = [...new Set([...MAIN, ...(ctx.window.VG_LANG_FILES || [])])];

// Texte, die der Mod nicht selbst schreibt, aber anzeigt: Statuszeilen vom Host und Meldungen
// vom Server kommen immer auf Deutsch und werden beim Anzeigen übersetzt (join_screen.gd).
const EXTERNAL = [
  '{} ist dran', 'Alle warten auf die Aufnahme von {}', 'Die Aufnahme ist nicht rechtzeitig angekommen.',
  'Die Runde ist schon vorbei.', 'Senden fehlgeschlagen', 'Diesen Raum gibt es nicht (mehr).',
  'Der Clip ist noch nicht hochgeladen.', 'Diese Runde ist nicht mehr aktiv.',
  'Der Raum ist voll.', 'Der Server ist gerade voll. Versuch es später nochmal.',
  'Gerade sind zu viele Räume offen. Versuch es gleich nochmal.', 'Zu viele neue Räume. Warte ein paar Minuten.',
  'Das Video ist für den Export zu lang.', 'Der Export ist fehlgeschlagen.', 'Etwas ist schiefgelaufen',
];

// Texte im Mod finden
const keys = new Set(EXTERNAL);
const rx = /(?:I18n\.t|\btr_|\b_t)\(\s*"((?:[^"\\]|\\.)*)"/g;   // tr_ und _t: Kurzformen in den Skripten
for (const f of fs.readdirSync(MOD).filter((n) => n.endsWith('.gd'))) {
  const src = fs.readFileSync(path.join(MOD, f), 'utf8');
  for (const m of src.matchAll(rx)) keys.add(JSON.parse(`"${m[1]}"`));
}

const langFile = path.join(MOD, 'lang.json');
const old = fs.existsSync(langFile) ? JSON.parse(fs.readFileSync(langFile, 'utf8')) : {};
const out = {};
const missing = {};
for (const code of langs) {
  out[code] = {};
  for (const k of [...keys].sort()) {
    const v = old[code]?.[k] ?? web[code]?.[k];
    if (v) out[code][k] = v;
    else (missing[k] ??= []).push(code);
  }
}

const gaps = Object.keys(missing);
console.log(`${keys.size} Texte im Mod, ${langs.length} Sprachen, ${gaps.length} mit Lücken`);
for (const k of gaps) console.log(`  fehlt (${missing[k].length}): ${k}`);
if (process.argv.includes('--check')) process.exit(gaps.length ? 1 : 0);
fs.writeFileSync(langFile, JSON.stringify(out, null, '\t') + '\n');
console.log(`geschrieben: ${path.relative(ROOT, langFile)}`);
