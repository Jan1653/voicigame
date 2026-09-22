// Schutz für einen öffentlichen Server: Räume kann jeder anlegen und darin hochladen.
// Damit das den VPS (und andere Dienste darauf) nicht volllaufen lässt:
//   MAX_ROOMS          höchstens so viele offene Räume (Standard 150)
//   MAX_PLAYERS_PER_ROOM  Handys/Browser je Raum (Standard 16)
//   ROOMS_PER_IP       neue Räume je Adresse in 10 Minuten (Standard 8)
//   MAX_STORAGE_GB     Clips, Packs und Aufnahmen aller Räume zusammen (Standard 8)
import fs from 'node:fs';
import path from 'node:path';
import { count } from './stats.js';

export const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 150;
export const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM) || 16;
const ROOMS_PER_IP = Number(process.env.ROOMS_PER_IP) || 8;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_STORAGE = (Number(process.env.MAX_STORAGE_GB) || 8) * 1024 ** 3;

const created = new Map(); // Adresse -> Zeitpunkte der letzten Raum-Erstellungen

/** Darf diese Adresse gerade noch einen Raum anlegen? Zählt den Versuch mit. */
export function allowRoom(ip) {
  const now = Date.now();
  const list = (created.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= ROOMS_PER_IP) {
    created.set(ip, list);
    return false;
  }
  list.push(now);
  created.set(ip, list);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of created) if (!list.some((t) => now - t < WINDOW_MS)) created.delete(ip);
}, WINDOW_MS).unref();

/* ---------- Speicherplatz ---------- */

let usedCache = { at: 0, bytes: 0 };

function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) {
      try { total += fs.statSync(p).size; } catch {}
    }
  }
  return total;
}

/** Belegter Platz im Datenordner (höchstens alle 5 s neu gezählt). */
export function storageUsed(dataDir) {
  if (Date.now() - usedCache.at > 5000) usedCache = { at: Date.now(), bytes: dirSize(dataDir) };
  return usedCache.bytes;
}

/** Wie viele Bytes dürfen noch dazukommen? */
export function storageLeft(dataDir) {
  return Math.max(0, MAX_STORAGE - storageUsed(dataDir));
}

/** Nach einem Upload den Zähler sofort erhöhen, damit parallele Uploads ihn sehen. */
export function storageAdd(bytes) {
  usedCache.bytes += Math.max(0, bytes || 0);
}

/** Antwortet mit 507 und false, wenn für want Bytes kein Platz mehr ist. */
export function checkStorage(res, dataDir, want = 0) {
  if (storageLeft(dataDir) > want) return true;
  count('full_storage');
  res.status(507).json({ error: 'storage_full', message: 'Der Server ist gerade voll. Versuch es später nochmal.' });
  return false;
}
