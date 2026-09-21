import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

/**
 * ffmpeg sparsam nutzen: immer nur ein Auftrag gleichzeitig, niedrige Priorität, Zeitlimit.
 * Auf dem Server laufen noch andere Spiele, die sollen nicht ausgebremst werden.
 *
 * Einstellungen (Umgebung):
 *   FFMPEG          Pfad zu ffmpeg (Standard: ffmpeg aus dem PATH)
 *   FFMPEG_THREADS  Threads je Auftrag (Standard 2)
 */

const THREADS = String(Math.max(1, Number(process.env.FFMPEG_THREADS) || 2));
let FFMPEG = null;

export function findFfmpeg() {
  if (FFMPEG !== null) return FFMPEG || null;
  const cand = process.env.FFMPEG || 'ffmpeg';
  try {
    FFMPEG = spawnSync(cand, ['-version'], { timeout: 30000 }).status === 0 ? cand : '';
  } catch {
    FFMPEG = '';
  }
  return FFMPEG || null;
}

const queue = [];
let running = null;

/**
 * Auftrag einreihen. -> Promise, erfüllt nach Ende.
 * args: ffmpeg-Argumente ohne Programmname. opts: {timeoutMs, duration (s, für Fortschritt), onProgress(0..1), key}
 * key: gleicher Schlüssel schon in der Warteschlange -> derselbe Auftrag wird zurückgegeben.
 */
export function ffmpeg(args, opts = {}) {
  const bin = findFfmpeg();
  if (!bin) return Promise.reject(new Error('ffmpeg fehlt'));
  if (opts.key) {
    const same = queue.find((j) => j.key === opts.key) || (running?.key === opts.key ? running : null);
    if (same) return same.promise;
  }
  const job = { args, opts, key: opts.key || null };
  job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
  queue.push(job);
  pump();
  return job.promise;
}

export function queueLength() {
  return queue.length + (running ? 1 : 0);
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  const { opts } = job;
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', THREADS, ...(opts.duration ? ['-progress', 'pipe:1', '-nostats'] : []), ...job.args];
  let child;
  try {
    child = spawn(findFfmpeg(), args, { windowsHide: true });
  } catch (e) {
    running = null;
    job.reject(e);
    return pump();
  }
  try { os.setPriority(child.pid, 10); } catch {}
  let err = '';
  let buf = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  child.stdout.on('data', (d) => {
    if (!opts.duration || !opts.onProgress) return;
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const m = l.match(/^out_time_(?:us|ms)=(\d+)/);
      if (m) opts.onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / opts.duration)));
    }
  });
  const limit = setTimeout(() => {
    err += '\nZeitlimit erreicht';
    child.kill('SIGKILL');
  }, opts.timeoutMs || 15 * 60 * 1000);
  child.on('error', (e) => { err += '\n' + e.message; });
  child.on('close', (code) => {
    clearTimeout(limit);
    running = null;
    if (code === 0) job.resolve();
    else job.reject(new Error(`ffmpeg ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    pump();
  });
}

/** Dauer, Bildgröße und Codecs einer Datei (über ffmpeg selbst, ohne ffprobe). */
export function probe(file) {
  return new Promise((resolve) => {
    const bin = findFfmpeg();
    if (!bin) return resolve(null);
    const child = spawn(bin, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let text = '';
    child.stderr.on('data', (d) => { text += d; });
    const limit = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(limit);
      const d = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      const v = text.match(/Stream #[^\n]*Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/);
      const a = text.match(/Stream #[^\n]*Audio: (\w+)/);
      resolve({
        duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
        video: v ? { codec: v[1], width: Number(v[2]), height: Number(v[3]) } : null,
        audio: a ? { codec: a[1] } : null,
      });
    });
  });
}
