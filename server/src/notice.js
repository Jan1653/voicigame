/* Hinweise an Spiele mit Mod und an die Webseite.
 *
 * Zwei Sorten:
 *   1. Versionshinweis. WANT_MOD ist die Version, mit der der Server rechnet. Wer älter ist, sieht einen
 *      Hinweis; wer älter als MIN_MOD ist, kann keinen Raum mehr aufmachen (dann hat sich etwas geändert,
 *      das sich nicht überbrücken lässt).
 *   2. Freier Text. Steht in <DATA_DIR>/notice.txt (oder in NOTICE), gilt für alle, z. B. „Heute Abend Wartung“.
 *      Datei ändern reicht, der Server muss nicht neu starten.
 *
 * Der Client bekommt einen Code und baut seinen Text selbst, damit der Hinweis in der Sprache des Spielers
 * ankommt. Nur der freie Text geht so raus, wie er in der Datei steht.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Mit dieser Mod-Version rechnet der Server. Ältere sehen „bitte aktualisieren“. */
export const WANT_MOD = process.env.WANT_MOD || '1.0.0';
/** Darunter geht gar nichts mehr: kein neuer Raum. */
export const MIN_MOD = process.env.MIN_MOD || '0.8.0';

const NOTICE_MS = 10000;   // so lange wird die Datei nicht neu gelesen
let noticeAt = 0;
let noticeText = null;

/** Versionen wie „1.2.3“ vergleichen. -> -1, 0, 1 */
export function cmpVersion(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const isVersion = (v) => /^\d+(\.\d+){0,3}$/.test(String(v || ''));

/** Ist diese Mod-Version zu alt, um einen Raum aufzumachen? */
export function tooOld(version) {
  return isVersion(version) && cmpVersion(version, MIN_MOD) < 0;
}

/** Freier Text für alle, aus <DATA_DIR>/notice.txt oder NOTICE. "" = keiner. */
export function freeNotice(dataDir) {
  if (process.env.NOTICE) return String(process.env.NOTICE).slice(0, 500);
  const now = Date.now();
  if (now - noticeAt < NOTICE_MS) return noticeText;
  noticeAt = now;
  try {
    noticeText = fs.readFileSync(path.join(dataDir, 'notice.txt'), 'utf8').trim().slice(0, 500) || null;
  } catch {
    noticeText = null;
  }
  return noticeText;
}

/**
 * Hinweise für einen Client. msg: die hello-Nachricht (client, version).
 * -> [{code, level, text, need}]  level: info | update | block
 */
export function noticesFor(dataDir, msg) {
  const out = [];
  const free = freeNotice(dataDir);
  if (free) out.push({ code: 'server', level: 'info', text: free });
  const v = String(msg?.version || '');
  if (msg?.client === 'game' && isVersion(v) && cmpVersion(v, WANT_MOD) < 0) {
    out.push({
      code: 'mod_old',
      level: cmpVersion(v, MIN_MOD) < 0 ? 'block' : 'update',
      text: '',
      have: v,
      need: WANT_MOD,
    });
  }
  return out;
}

export function installNotice(app, dataDir) {
  app.get('/api/notice', (req, res) => {
    const free = freeNotice(dataDir);
    res.set('Cache-Control', 'no-cache').json({ text: free || '', wantMod: WANT_MOD, minMod: MIN_MOD });
  });
}
