/* Warteschlange für neue Räume, wenn der Server voll oder überlastet ist.
 *   MAX_ACTIVE_ROOMS  so viele Räume gleichzeitig in Benutzung (PC oder Handy verbunden), Standard 60
 *   OVERLOAD_LAG_MS   überlastet, wenn der Server spürbar hinterherhinkt (99 % der Messungen darunter), Standard 250
 * Wer keinen Raum bekommt, erhält eine Wartenummer (Ticket) und fragt alle paar Sekunden nach.
 * Frei werdende Plätze gehen der Reihe nach an die Wartenden. Wer nicht mehr nachfragt, fällt heraus. */
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { count, peak, observe } from './stats.js';

export const MAX_ACTIVE_ROOMS = Number(process.env.MAX_ACTIVE_ROOMS) || 60;
const LAG_MS = Number(process.env.OVERLOAD_LAG_MS) || 250;
const STALE_MS = 20_000;

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let overloaded = false;
setInterval(() => {
  const p99 = lag.percentile(99) / 1e6;
  overloaded = p99 > LAG_MS;
  peak('lag_ms', Math.round(p99));
  if (overloaded) count('busy_s', 10);   // für die Statistik: so lange war der Server überlastet
  lag.reset();
}, 10_000).unref();

export const isOverloaded = () => overloaded;

const waiting = []; // { ticket, since, seen } in Reihenfolge

function prune() {
  const now = Date.now();
  for (let i = waiting.length - 1; i >= 0; i--) if (now - waiting[i].seen > STALE_MS) waiting.splice(i, 1);
}

/** Darf jetzt ein neuer Raum entstehen? free = freie Plätze.
 *  -> { ok: true } oder { ok: false, ticket, position } (Platz 1 = als Nächstes dran) */
export function admit(ticket, free) {
  prune();
  const i = ticket ? waiting.findIndex((w) => w.ticket === ticket) : -1;
  const position = i >= 0 ? i + 1 : waiting.length + 1;
  if (position <= free) {
    if (i >= 0) {
      observe('queue_s', (Date.now() - waiting[i].since) / 1000);
      waiting.splice(i, 1);
    }
    return { ok: true };
  }
  if (i >= 0) {
    waiting[i].seen = Date.now();
    return { ok: false, ticket, position };
  }
  const t = crypto.randomBytes(8).toString('hex');
  waiting.push({ ticket: t, since: Date.now(), seen: Date.now() });
  count('queued');
  peak('queue', waiting.length);
  return { ok: false, ticket: t, position: waiting.length };
}

export function queueLength() {
  prune();
  return waiting.length;
}
