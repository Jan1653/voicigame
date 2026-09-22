'use strict';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Übersetzen: die Seite übersetzt geschriebene Texte selbst (i18n.js). Nur wo nichts im DOM landet
// (Canvas, Fenstertitel), muss der Code tr() selbst aufrufen.
const tr = (s) => (window.t ? window.t(s) : s);

/** Name (wird nie übersetzt) plus optionaler Zusatz wie „(du)“, der übersetzt wird. */
function nameNode(name, extra) {
  const f = document.createDocumentFragment();
  const n = document.createElement('span');
  n.setAttribute('data-nolang', '');
  n.textContent = name;
  f.append(n);
  if (extra) f.append(' ' + extra);
  return f;
}

document.title = tr('Mitspielen');
document.addEventListener('vg-lang', () => {
  document.title = tr('Mitspielen');
  drawVoice();
});
const params = new URLSearchParams(location.search);

const S = {
  ws: null,
  code: (params.get('r') || '').toUpperCase(),
  token: null,
  name: '',
  playerId: null,
  state: null,
  myQueue: [],
  clipsById: {},
  stream: null,
  ctx: null,
  wakeLock: null,
  joined: false,
  retry: 0,
  lastResult: null,
  rec: null, // {turnId, phase, until, stop}
  showRound: null, // Gameshow: zuletzt gesehene Runde
  cast: { want: true, sent: null, sound: false, url: null, busy: false, t: 0, frames: 0 }, // Live-Bild vom Spiel
};
try { S.cast.want = localStorage.getItem('vp:live') !== 'off'; } catch {}

/** Gameshow: alle nehmen denselben Clip auf, das Spiel am PC bewertet. Sonst Synchro (Zug für Zug). */
const isShow = () => S.state?.show?.game === 'show';

/** Aktueller Zug. In der Gameshow ist das die laufende Runde, falls dieses Handy mitmacht. */
function curTurn() {
  if (!isShow()) return S.state?.turn || null;
  const r = S.state?.show?.round;
  if (!r) return null;
  const mine = r.recorders.includes(S.playerId);
  return { turnId: r.roundId, clipId: r.clipId, index: r.index, playerId: mine ? S.playerId : null, show: r };
}

/** Neue Gameshow-Runde: alten Stand wegräumen, Clip nach vorn holen. */
function onShowRound(r) {
  if (!r || S.showRound === r.roundId) return;
  S.showRound = r.roundId;
  S.rec = null;
  S.review = null;
  S.live = null;
  DL.prioritize(r.clipId);
  if (r.recorders.includes(S.playerId)) navigator.vibrate?.(120);
}

/* ================= Beitreten ================= */

function stored(code) {
  try { return JSON.parse(localStorage.getItem('vp:' + code) || 'null'); } catch { return null; }
}
function store(code, data) {
  try { localStorage.setItem('vp:' + code, JSON.stringify(data)); } catch {}
}

$('#join-code').value = S.code;
$('#join-name').value = (() => { try { return localStorage.getItem('vp:name') || ''; } catch { return ''; } })();

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  const name = $('#join-name').value.trim();
  if (!code || !name) return;
  const err = $('#join-error');
  err.hidden = true;
  const btn = e.submitter || $('#join-form button');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error('Diesen Raumcode gibt es nicht. Schau nochmal auf den PC.');
    await setupAudio();
    S.code = code;
    S.name = name;
    try { localStorage.setItem('vp:name', name); } catch {}
    S.token = stored(code)?.token || null;
    history.replaceState(null, '', `?r=${code}`);
    connect();
  } catch (ex) {
    err.textContent = ex.message || String(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function setupAudio() {
  if (!window.isSecureContext) throw new Error('Das Mikrofon geht nur über https. Der Host muss die Seite über https freigeben.');
  if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (S.ctx.state === 'suspended') await S.ctx.resume();
  await ensureMic();
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

async function ensureMic() {
  if (S.stream && S.stream.getAudioTracks().some((t) => t.readyState === 'live')) return;
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    throw new Error('Ohne Mikrofon kannst du nicht aufnehmen. Erlaube den Zugriff in den Browser-Einstellungen und tipp nochmal auf Beitreten.');
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.joined) {
    try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    if (S.ctx?.state === 'suspended') S.ctx.resume().catch(() => {});
    if (!S.ws || S.ws.readyState > 1) connect();
  }
});

/* ================= Verbindung ================= */

/* Grobe Angaben zum Gerät für die Nutzungsstatistik des Servers (nur Tagessummen, nichts Persönliches):
   gewählte Sprache, Zeitzone und Land aus den Einstellungen des Browsers, eingestellter Stil. */
function clientInfo() {
  const info = { client: 'web' };
  try {
    info.lang = window.VG_I18N?.lang;
    info.pick = window.VG_I18N?.chosen ? 'selbst' : 'geraet';
    info.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    info.land = String(navigator.language || '').split('-')[1];
    const el = document.documentElement;
    info.style = el.dataset.theme === 'dark' ? 'dark' : el.dataset.style;
  } catch (e) { /* egal, dann eben ohne */ }
  return info;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  S.cast.sent = null;
  ws.onopen = () => {
    S.retry = 0;
    ws.send(JSON.stringify({ type: 'hello', role: 'phone', code: S.code, name: S.name, token: S.token, ...clientInfo() }));
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) return onLiveFrame(ev.data);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  };
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    if (ev.code === 4001 || ev.code === 1000) return;
    if (!S.joined) return;
    const delay = Math.min(8000, 500 * 2 ** S.retry++);
    toast('Verbindung weg, verbinde neu …');
    setTimeout(() => { if (S.ws === ws) connect(); }, delay);
  };
}

function wsSend(msg) {
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function onMessage(msg) {
  window.Dub?.onMessage(msg); // Dub-Modus: eigene Datei dub.js
  switch (msg.type) {
    case 'welcome': {
      S.joined = true;
      S.playerId = msg.playerId;
      S.token = msg.token;
      store(S.code, { token: msg.token });
      const have = [...DL.cache.keys()];
      if (have.length) wsSend({ type: 'clip.cached', clipIds: have });
      break;
    }
    case 'state':
      S.state = msg.state;
      S.myQueue = msg.state.me?.queue || [];
      S.clipsById = Object.fromEntries(msg.state.clips.map((c) => [c.id, c]));
      if (isShow()) {
        // Alle Clips vorladen, die laufende Runde zuerst
        const r = msg.state.show.round;
        const ids = msg.state.clips.map((c) => c.id);
        const from = r ? Math.max(0, ids.indexOf(r.clipId)) : 0;
        S.myQueue = ids.slice(from).concat(ids.slice(0, from));
        onShowRound(r);
      }
      DL.want(S.myQueue);
      syncLive();
      render();
      break;
    case 'show.round':
      onShowRound(msg.round);
      break;
    case 'show.scores':
    case 'show.end':
      render();
      break;
    case 'turn.started':
      if (msg.turn.playerId === S.playerId) {
        S.rec = null;
        S.review = null;
        S.live = null;
        DL.prioritize(msg.turn.clipId);
        navigator.vibrate?.(120);
      }
      break;
    case 'turn.record':
      record(msg.turnId, msg.seconds, msg.countdown);
      break;
    case 'turn.result':
      S.lastResult = msg.result;
      render();
      break;
    case 'game.started':
      S.lastResult = null;
      break;
    case 'kicked':
      S.joined = false;
      store(S.code, null);
      toast('Du wurdest aus dem Raum entfernt.');
      showView('join');
      break;
    case 'error':
      if (msg.code === 'room_not_found') {
        S.joined = false;
        store(S.code, null);
        showView('join');
        const err = $('#join-error');
        err.textContent = 'Der Raum existiert nicht mehr. Frag nach dem neuen Code.';
        err.hidden = false;
      } else toast(msg.message || msg.code);
      break;
  }
}

/* ================= Download-Manager =================
 * Lädt die eigenen Clips in Spielreihenfolge. Der aktuelle Zug hat immer Vorrang.
 * Fehlgeschlagene Downloads werden automatisch wiederholt. */

const DL = {
  cache: new Map(), // clipId -> {blob, url}
  list: [],
  busy: false,
  current: null,
  progress: {}, // clipId -> 0..1

  want(ids) {
    this.list = ids.filter((id) => !this.cache.has(id));
    this.pump();
  },

  prioritize(id) {
    if (this.cache.has(id)) return;
    this.list = [id, ...this.list.filter((x) => x !== id)];
    this.pump();
  },

  async pump() {
    if (this.busy) return;
    this.busy = true;
    let fails = 0;
    while (S.joined) {
      const id = this.list.find((x) => !this.cache.has(x) && S.clipsById[x]?.available);
      if (!id) break;
      try {
        await this.fetchClip(id);
        fails = 0;
      } catch (e) {
        fails++;
        console.warn('Download fehlgeschlagen', id, e);
        await sleep(Math.min(10000, 1000 * fails));
      }
    }
    this.busy = false;
  },

  async fetchClip(id) {
    this.current = id;
    const res = await fetch(`/api/rooms/${S.code}/clips/${encodeURIComponent(id)}?t=${S.token}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || S.clipsById[id]?.size || 0;
    const type = res.headers.get('content-type') || 'audio/mpeg';
    const chunks = [];
    let loaded = 0;
    let lastSent = 0;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        this.progress[id] = total ? loaded / total : 0;
        const turn = curTurn();
        if (turn && turn.clipId === id && turn.playerId === S.playerId && Date.now() - lastSent > 400) {
          lastSent = Date.now();
          if (!turn.show) wsSend({ type: 'turn.progress', turnId: turn.turnId, pct: this.progress[id] });
          renderTurn();
        }
      }
    } else {
      chunks.push(new Uint8Array(await res.arrayBuffer()));
    }
    const blob = new Blob(chunks, { type });
    this.cache.set(id, { blob, url: URL.createObjectURL(blob) });
    this.progress[id] = 1;
    this.current = null;
    wsSend({ type: 'clip.cached', clipId: id });
    render();
  },
};

/* ================= Abspielen & Aufnehmen ================= */

let player = null;

/** Welcher Clip gerade in der Stimmkurve steht: eigener Zug oder letzte Auswertung. */
function cardClipId() {
  const turn = curTurn();
  if (turn && turn.playerId === S.playerId) return turn.clipId;
  return S.review?.clipId || null;
}

function playUrl(url, which) {
  if (player) player.pause();
  player = new Audio(url);
  S.playing = which;
  player.onended = player.onpause = () => {
    if (S.playing === which) S.playing = null;
    S.playhead = null;
    drawVoice();
  };
  player.play().then(() => {
    const tick = () => {
      if (S.playing !== which || !player || player.paused) return;
      S.playhead = player.currentTime;
      drawVoice();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }).catch(() => toast('Abspielen nicht möglich'));
}

$('#btn-listen').addEventListener('click', () => {
  const c = DL.cache.get(cardClipId());
  if (c) playUrl(c.url, 'original');
});

$('#btn-mine').addEventListener('click', () => {
  if (S.review?.recUrl) playUrl(S.review.recUrl, 'mine');
});

$('#btn-stop').addEventListener('click', () => S.rec?.stop?.());

// Gameshow: der Spieler startet seine Aufnahme selbst, wenn er den Clip gehört hat
$('#orb').addEventListener('click', () => {
  const turn = curTurn();
  if (!turn?.show || turn.playerId !== S.playerId || !DL.cache.has(turn.clipId)) return;
  if (S.rec && S.rec.turnId === turn.turnId && S.rec.phase !== 'error') return;
  if (turn.show.done.includes(S.playerId)) return;
  const r = turn.show;
  record(r.roundId, Math.max(1, r.seconds - r.leadIn), r.countdown || 3, r.leadIn);
});

/** Aufnahme für einen Zug. pad = Stille vorneweg, damit die Stimme im Spiel genau zum Clip passt. */
async function record(turnId, seconds, countdown, pad = 0) {
  if (S.rec && S.rec.turnId === turnId && S.rec.phase !== 'error') return;
  if (player) player.pause();
  const show = !!curTurn()?.show;
  const clipId = curTurn()?.clipId;
  S.rec = { turnId, phase: 'countdown', n: countdown };
  S.review = null;
  S.live = null;
  navigator.vibrate?.([80, 60, 80]);
  try {
    await ensureMic();
    if (S.ctx?.state === 'suspended') await S.ctx.resume().catch(() => {});
  } catch (e) {
    S.rec.phase = 'error';
    S.rec.error = e.message;
    renderTurn();
    return;
  }
  getAnalysis(clipId); // Ziel-Kurve schon mal berechnen
  for (let n = countdown; n > 0; n--) {
    S.rec.n = n;
    renderTurn();
    await sleep(1000);
  }

  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  // Höchste Bitrate: der Browser nimmt nur zwischendurch komprimiert auf, hochgeladen wird danach ohnehin WAV.
  // Mit der Standard-Bitrate mancher Handys klang das hörbar schlechter.
  const mr = new MediaRecorder(S.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 256000 });
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (mr.onstop = r));

  let timer;
  const finish = () => {
    clearTimeout(timer);
    if (mr.state !== 'inactive') mr.stop();
  };
  S.live = { points: [], env: [], seconds };
  S.rec = { turnId, phase: 'recording', start: performance.now(), seconds, stop: finish };
  mr.start(250);
  timer = setTimeout(finish, seconds * 1000);
  startLivePitch();
  renderTurn();
  await stopped;

  S.rec = { turnId, phase: 'sending' };
  renderTurn();
  try {
    const { blob, pcm, rate } = await toWav(new Blob(chunks, { type: mr.mimeType || mimeType || 'audio/webm' }), pad);
    const take = analyze(pad ? pcm.subarray(Math.round(pad * rate)) : pcm, rate);
    const target = await getAnalysis(clipId);
    const score = target ? scoreTake(target, take) : null;
    S.review = { clipId, turnId, take, score, recUrl: URL.createObjectURL(blob) };
    renderVoiceCard();
    // Die eigene Aufnahme bleibt auf dem Gerät, auch wenn der Raum längst zu ist
    window.VG_TAKES?.save({
      room: S.code, mode: show ? 'show' : 'turn', clip: clipId,
      caption: S.state?.clips?.find((c) => c.id === clipId)?.title || '',
      seconds: pcm.length / rate,
    }, blob);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      const kind = show ? 'rounds' : 'turns';
      const res = await fetch(`/api/rooms/${S.code}/${kind}/${turnId}/recording?t=${S.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav', ...(score ? { 'X-Phone-Score': JSON.stringify(score) } : {}) },
        body: blob,
      });
      if (res.status === 409) throw new Error('Die Runde ist schon vorbei.');
      ok = res.ok;
      if (!ok) await sleep(800);
    }
    if (!ok) throw new Error('Senden fehlgeschlagen');
    S.rec = { turnId, phase: 'sent' };
  } catch (e) {
    S.rec = { turnId, phase: 'error', error: e.message };
  }
  renderTurn();
}

/** Live-Tonhöhe während der Aufnahme, zeichnet Ring und Stimmkurve. */
function startLivePitch() {
  if (!S.analyser) {
    const src = S.ctx.createMediaStreamSource(S.stream);
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = 2048;
    src.connect(S.analyser);
    S.analyserStream = S.stream;
  } else if (S.analyserStream !== S.stream) {
    S.ctx.createMediaStreamSource(S.stream).connect(S.analyser);
    S.analyserStream = S.stream;
  }
  const buf = new Float32Array(S.analyser.fftSize);
  const fill = $('#ring-fill');
  let frame = 0;
  const tick = () => {
    if (S.rec?.phase !== 'recording') {
      fill.style.strokeDashoffset = 339.3;
      S.playhead = null;
      drawVoice();
      return;
    }
    const el = (performance.now() - S.rec.start) / 1000;
    const t = Math.min(1, el / S.rec.seconds);
    fill.style.strokeDashoffset = 339.3 * (1 - t);
    $('#orb-label').textContent = Math.ceil(S.rec.seconds * (1 - t)) + ' s';
    if (frame++ % 2 === 0) {
      S.analyser.getFloatTimeDomainData(buf);
      let e = 0;
      for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
      const rms = Math.sqrt(e / buf.length);
      S.live.env.push({ t: el, rms });
      let midi = NaN;
      if (rms > 0.012) {
        const d = downsample(buf, S.ctx.sampleRate);
        const hz = yin(d.data, d.rate, 0, d.data.length);
        if (hz > 0) midi = hzToMidi(hz);
      }
      S.live.points.push({ t: el, midi });
    }
    S.playhead = el;
    drawVoice();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Beliebige Aufnahme (webm/opus, mp4/aac) -> WAV, 44,1 kHz, Mono, 16 Bit. Das kann Godot direkt lesen.
 *  pad: Sekunden Stille vorneweg. */
async function toWav(blob, pad = 0) {
  const rate = 44100;
  const decoded = await S.ctx.decodeAudioData(await blob.arrayBuffer());
  const length = Math.max(1, Math.ceil((decoded.duration + pad) * rate));
  const off = new OfflineAudioContext(1, length, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(pad);
  const out = await off.startRendering();
  const pcm = out.getChannelData(0);

  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return { blob: new Blob([buf], { type: 'audio/wav' }), pcm, rate };
}

/* ================= Stimm-Analyse =================
 * Tonhöhe mit YIN, Lautstärke-Hüllkurve und Wellenform.
 * Vergleich Original gegen Aufnahme: Tonhöhe (DTW, Oktaven zählen fast gleich),
 * Timing (Hüllkurven-Korrelation) und Länge (Dauer mit Stimme). */

const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
const clamp100 = (x) => Math.max(0, Math.min(100, Math.round(x)));
const analyses = new Map(); // clipId -> Promise<analysis|null>

function getAnalysis(clipId) {
  if (!clipId) return Promise.resolve(null);
  if (analyses.has(clipId)) return analyses.get(clipId);
  const c = DL.cache.get(clipId);
  if (!c || !S.ctx) return Promise.resolve(null);
  const p = c.blob.arrayBuffer()
    .then((ab) => S.ctx.decodeAudioData(ab))
    .then((buf) => {
      const a = analyze(mixDown(buf), buf.sampleRate);
      c.analysis = a;
      renderVoiceCard();
      return a;
    })
    .catch((e) => {
      console.warn('Analyse fehlgeschlagen', e);
      return null;
    });
  analyses.set(clipId, p);
  return p;
}

function mixDown(ab) {
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

function downsample(pcm, rate) {
  const k = Math.max(1, Math.round(rate / 16000));
  if (k === 1) return { data: pcm, rate };
  const n = Math.floor(pcm.length / k);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < k; j++) s += pcm[i * k + j];
    out[i] = s / k;
  }
  return { data: out, rate: rate / k };
}

/** YIN-Tonhöhe im Bereich 70 bis 1000 Hz. Gibt Hz zurück oder 0 für "keine Tonhöhe". */
function yin(buf, rate, start, size) {
  const minLag = Math.max(2, Math.floor(rate / 1000));
  const maxLag = Math.min(Math.floor(rate / 70), Math.floor(size / 2));
  const W = size - maxLag;
  if (W < 32 || maxLag <= minLag) return 0;
  const d = new Float32Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1 && tau < size - W + 1; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const x = buf[start + i] - buf[start + i + tau];
      s += x * x;
    }
    d[tau] = s;
  }
  let sum = 0;
  d[0] = 1;
  for (let tau = 1; tau <= maxLag; tau++) {
    sum += d[tau];
    d[tau] = sum ? (d[tau] * tau) / sum : 1;
  }
  let best = -1;
  for (let tau = minLag; tau < maxLag; tau++) {
    if (d[tau] < 0.15) {
      while (tau + 1 < maxLag && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) return 0;
  const a = d[best - 1], b = d[best], c = d[best + 1];
  const den = a + c - 2 * b;
  const shift = den ? (a - c) / (2 * den) : 0;
  return rate / (best + (Math.abs(shift) < 1 ? shift : 0));
}

function analyze(pcm, rate) {
  const { data, rate: r } = downsample(pcm, rate);
  const size = 1024;
  const hop = Math.round(r * 0.02);
  const frames = Math.max(0, Math.floor((data.length - size) / hop) + 1);
  const midi = new Float32Array(frames).fill(NaN);
  const rms = new Float32Array(frames);
  let peak = 1e-9;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < size; i++) e += data[f * hop + i] ** 2;
    rms[f] = Math.sqrt(e / size);
    peak = Math.max(peak, rms[f]);
  }
  const gate = Math.max(peak * 0.1, 0.004);
  for (let f = 0; f < frames; f++) {
    if (rms[f] < gate) continue;
    const hz = yin(data, r, f * hop, size);
    if (hz > 0) midi[f] = hzToMidi(hz);
  }
  // Ausreißer glätten (Median aus 3)
  const sm = Float32Array.from(midi);
  for (let f = 1; f < frames - 1; f++) {
    const v = [midi[f - 1], midi[f], midi[f + 1]].filter((x) => !isNaN(x)).sort((a, b) => a - b);
    if (!isNaN(midi[f]) && v.length === 3) sm[f] = v[1];
  }
  for (let f = 0; f < frames; f++) rms[f] /= peak;
  return { hop: hop / r, midi: sm, rms, duration: pcm.length / rate, wave: peaks(pcm, 300) };
}

function peaks(pcm, n) {
  const out = new Float32Array(n);
  const step = pcm.length / n;
  let max = 1e-9;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = Math.floor(i * step), e = Math.floor((i + 1) * step); j < e; j++) m = Math.max(m, Math.abs(pcm[j]));
    out[i] = m;
    max = Math.max(max, m);
  }
  for (let i = 0; i < n; i++) out[i] /= max;
  return out;
}

/** Nutzer-Tonhöhe in die Oktave schieben, die am nächsten am Ziel liegt. */
function fold(u, target) {
  if (isNaN(u) || isNaN(target)) return u;
  return u - 12 * Math.round((u - target) / 12);
}

function pitchCost(a, b) {
  const va = !isNaN(a), vb = !isNaN(b);
  if (!va && !vb) return 0;
  if (va !== vb) return 3;
  const d0 = b - a;
  const k = Math.round(d0 / 12);
  return Math.min(8, Math.abs(d0 - 12 * k) + (k ? 1 : 0));
}

function trimSeq(arr, max = 250) {
  let a = 0, b = arr.length - 1;
  while (a < b && isNaN(arr[a])) a++;
  while (b > a && isNaN(arr[b])) b--;
  const s = arr.slice(a, b + 1);
  const k = Math.max(1, Math.ceil(s.length / max));
  return k === 1 ? s : s.filter((_, i) => i % k === 0);
}

function dtw(A, B) {
  const n = A.length, m = B.length;
  if (!n || !m) return 8;
  let pc = new Float64Array(m + 1).fill(Infinity), pl = new Float64Array(m + 1);
  pc[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cc = new Float64Array(m + 1).fill(Infinity), cl = new Float64Array(m + 1);
    for (let j = 1; j <= m; j++) {
      let bc = pc[j - 1], bl = pl[j - 1];
      if (pc[j] < bc) { bc = pc[j]; bl = pl[j]; }
      if (cc[j - 1] < bc) { bc = cc[j - 1]; bl = cl[j - 1]; }
      cc[j] = bc + pitchCost(A[i - 1], B[j - 1]);
      cl[j] = bl + 1;
    }
    pc = cc;
    pl = cl;
  }
  return pc[m] / pl[m];
}

function envCorrelation(a, b, maxLag) {
  const norm = (x) => {
    const mean = x.reduce((s, v) => s + v, 0) / (x.length || 1);
    return Array.from(x, (v) => v - mean);
  };
  const A = norm(a), B = norm(b);
  let best = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0, ea = 0, eb = 0;
    for (let i = 0; i < A.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= B.length) continue;
      s += A[i] * B[j];
      ea += A[i] * A[i];
      eb += B[j] * B[j];
    }
    if (ea && eb) best = Math.max(best, s / Math.sqrt(ea * eb));
  }
  return best;
}

function scoreTake(target, take) {
  const voiced = (x) => x.midi.reduce((n, v) => n + (isNaN(v) ? 0 : 1), 0);
  const vt = voiced(target), vu = voiced(take);
  if (vu < 5) return { score: 0, pitch: 0, rhythm: 0, length: 0, grade: 'D', text: 'Kaum Stimme erkannt. Näher ans Mikro?' };
  const pitch = clamp100(100 * (1 - dtw(trimSeq(target.midi), trimSeq(take.midi)) / 4.5));
  const rhythm = clamp100(((envCorrelation(target.rms, take.rms, Math.round(0.6 / target.hop)) - 0.1) / 0.7) * 100);
  const length = clamp100((100 * Math.min(vt, vu)) / Math.max(vt, vu, 1));
  const score = clamp100(0.55 * pitch + 0.25 * rhythm + 0.2 * length);
  const grade = score >= 90 ? 'S' : score >= 78 ? 'A' : score >= 64 ? 'B' : score >= 48 ? 'C' : 'D';
  const weakest = [['pitch', pitch], ['rhythm', rhythm], ['length', length]].sort((a, b) => a[1] - b[1])[0][0];
  const text = score >= 90 ? 'Klingt fast wie das Original!'
    : weakest === 'pitch' ? 'Achte mehr auf die Tonhöhe.'
    : weakest === 'rhythm' ? 'Achte mehr auf das Timing.'
    : vu < vt ? 'Das war etwas zu kurz.' : 'Das war etwas zu lang.';
  return { score, pitch, rhythm, length, grade, text };
}

/* ================= Stimmkurve zeichnen ================= */

function renderVoiceCard() {
  const card = $('#voice-card');
  const clipId = cardClipId();
  const turn = curTurn();
  const myTurn = turn && turn.playerId === S.playerId;
  card.hidden = !clipId || S.state?.phase !== 'playing' || !(myTurn || S.review);
  if (card.hidden) return;
  if (DL.cache.has(clipId)) getAnalysis(clipId);

  const recording = S.rec?.phase === 'recording' || S.rec?.phase === 'countdown';
  $('#voice-title').textContent = S.review ? 'Deine Aufnahme' : 'So soll es klingen';
  $('#btn-listen').hidden = !DL.cache.has(clipId) || recording;
  $('#btn-mine').hidden = !S.review || recording;

  // In der Gameshow zählt nur die Bewertung vom Spiel, die eigene Schätzung bleibt weg
  const sc = isShow() ? null : S.review?.score;
  $('#score-box').hidden = !sc;
  if (sc) {
    $('#score-grade').textContent = sc.grade;
    $('#score-num').textContent = `${sc.score} von 100`;
    $('#m-pitch').style.width = sc.pitch + '%';
    $('#m-rhythm').style.width = sc.rhythm + '%';
    $('#m-length').style.width = sc.length + '%';
    $('#score-tip').textContent = sc.text;
  }
  drawVoice();
}

function drawVoice() {
  const cv = $('#voice-canvas');
  if ($('#voice-card').hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  const simple = document.documentElement.dataset.style === 'simple';
  const dark = simple && document.documentElement.dataset.theme === 'dark';
  const C = dark
    ? { wave: 'rgba(77,155,230,0.2)', waveYou: 'rgba(63,181,106,0.24)', band: 'rgba(77,155,230,0.3)', line: '#7ab6f0', text: '#9ba8b4', head: 'rgba(231,236,241,0.7)', good: '#3fb56a', mid: '#e0a33c', bad: '#e5566a', none: '#6d7884' }
    : simple
    ? { wave: 'rgba(43,127,212,0.12)', waveYou: 'rgba(47,158,85,0.18)', band: 'rgba(43,127,212,0.2)', line: '#1f63a8', text: '#5b6b78', head: 'rgba(29,43,54,0.6)', good: '#23793f', mid: '#d99a12', bad: '#d33a4a', none: '#8a9aa8' }
    : { wave: 'rgba(10,111,168,0.13)', waveYou: 'rgba(45,138,40,0.2)', band: 'rgba(25,179,230,0.3)', line: 'rgba(10,111,168,0.9)', text: 'rgba(6,56,90,0.55)', head: 'rgba(6,56,90,0.7)', good: '#2d8a28', mid: '#e0a21a', bad: '#e3334a', none: '#5b8fb2' };
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const clipId = cardClipId();
  const tgt = DL.cache.get(clipId)?.analysis || null;
  const review = S.review && S.review.clipId === clipId ? S.review : null;
  const clipMeta = S.clipsById[clipId];
  const T = Math.max(
    tgt?.duration || clipMeta?.duration || 3,
    review?.take.duration || 0,
    S.live?.seconds || 0,
    1
  );
  const X = (t) => (t / T) * w;

  // Bereich der Tonhöhe
  let lo = Infinity, hi = -Infinity;
  if (tgt) for (const v of tgt.midi) if (!isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo)) { lo = 48; hi = 72; }
  lo -= 4; hi += 4;
  if (hi - lo < 16) { const mid = (hi + lo) / 2; lo = mid - 8; hi = mid + 8; }
  const pad = 10;
  const Y = (m) => pad + (1 - (m - lo) / (hi - lo)) * (h - 2 * pad);
  const targetAt = (t) => {
    if (!tgt) return NaN;
    const i = Math.round(t / tgt.hop);
    return i >= 0 && i < tgt.midi.length ? tgt.midi[i] : NaN;
  };

  // Wellenformen
  const wave = (arr, dur, color) => {
    g.fillStyle = color;
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      const x = X((i / n) * dur);
      const a = arr[i] * (h / 2 - 4);
      g.fillRect(x, h / 2 - a, Math.max(1, X(dur / n) - 0.5), a * 2);
    }
  };
  if (tgt) wave(tgt.wave, tgt.duration, C.wave);
  if (review) wave(review.take.wave, review.take.duration, C.waveYou);
  if (!review && S.live?.env.length) {
    g.fillStyle = C.waveYou;
    for (const p of S.live.env) {
      const a = Math.min(1, p.rms * 6) * (h / 2 - 4);
      g.fillRect(X(p.t), h / 2 - a, 2, a * 2);
    }
  }

  // Ziel-Tonhöhe als breites Band
  const line = (pts, style, width) => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.lineCap = g.lineJoin = 'round';
    g.beginPath();
    let open = false;
    for (const [t, m] of pts) {
      if (isNaN(m)) { open = false; continue; }
      if (!open) { g.moveTo(X(t), Y(m)); open = true; } else g.lineTo(X(t), Y(m));
    }
    g.stroke();
  };
  if (tgt) {
    const pts = Array.from(tgt.midi, (m, i) => [i * tgt.hop, m]);
    line(pts, C.band, 14);
    line(pts, C.line, 2);
  } else {
    g.fillStyle = C.text;
    g.font = `700 14px ${getComputedStyle(document.body).fontFamily}`;
    g.textAlign = 'center';
    g.fillText(tr(DL.cache.has(clipId) ? 'Kurve wird berechnet …' : 'Clip lädt noch …'), w / 2, h / 2 + 5);
  }

  // Eigene Tonhöhe, eingefärbt nach Abstand zum Ziel
  const mine = review
    ? Array.from(review.take.midi, (m, i) => [i * review.take.hop, m])
    : (S.live?.points || []).map((p) => [p.t, p.midi]);
  let prev = null;
  g.lineWidth = 3.5;
  g.lineCap = 'round';
  for (const [t, raw] of mine) {
    const tm = targetAt(t);
    const m = fold(raw, isNaN(tm) ? (lo + hi) / 2 : tm);
    if (isNaN(m)) { prev = null; continue; }
    const m2 = Math.max(lo, Math.min(hi, m));
    const d = isNaN(tm) ? 99 : Math.abs(m - tm);
    const col = d <= 1.5 ? C.good : d <= 3 ? C.mid : isNaN(tm) ? C.none : C.bad;
    if (prev && t - prev[0] < 0.12) {
      g.strokeStyle = col;
      g.beginPath();
      g.moveTo(X(prev[0]), Y(prev[1]));
      g.lineTo(X(t), Y(m2));
      g.stroke();
    } else {
      g.fillStyle = col;
      g.beginPath();
      g.arc(X(t), Y(m2), 2, 0, Math.PI * 2);
      g.fill();
    }
    prev = [t, m2];
  }

  // Abspielposition
  if (S.playhead != null) {
    g.strokeStyle = C.head;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(S.playhead), 0);
    g.lineTo(X(S.playhead), h);
    g.stroke();
  }
}

window.addEventListener('resize', () => drawVoice());
window.addEventListener('stylechange', () => drawVoice());

/* ================= Live-Bild vom Spiel =================
 * Der PC schickt Bildschirmfotos (JPEG) und den Spielton (PCM 16 Bit mono), siehe server/src/stream.js.
 * Nur in der Gameshow während des Spiels. Während der eigenen Aufnahme bleibt der Ton stumm,
 * damit das Mikro ihn nicht mitnimmt. */

function liveWanted() {
  return S.cast.want && isShow() && S.state?.phase === 'playing';
}

function syncLive() {
  const on = !!(S.joined && liveWanted());
  if (on !== S.cast.sent) {
    S.cast.sent = on;
    wsSend({ type: 'watch', on });
  }
}

function onLiveFrame(buf) {
  const kind = new Uint8Array(buf, 0, 1)[0];
  if (kind === 1) {
    if (S.cast.busy || $('#view-game').hidden) return; // altes Bild noch nicht fertig: dieses auslassen
    S.cast.busy = true;
    const url = URL.createObjectURL(new Blob([buf.slice(1)], { type: 'image/jpeg' }));
    const img = $('#live-img');
    img.onload = img.onerror = () => {
      if (S.cast.url) URL.revokeObjectURL(S.cast.url);
      S.cast.url = url;
      S.cast.busy = false;
      if (!S.cast.frames++) renderLive();
    };
    img.src = url;
  } else if (kind === 2 && buf.byteLength > 5) {
    const recording = S.rec && ['countdown', 'recording'].includes(S.rec.phase);
    if (!S.cast.sound || recording || !S.ctx || S.ctx.state !== 'running') return;
    const rate = new DataView(buf).getUint32(1, true);
    const pcm = new Int16Array(buf.slice(5));
    if (!pcm.length || rate < 8000 || rate > 96000) return;
    const ab = S.ctx.createBuffer(1, pcm.length, rate);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = S.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(S.ctx.destination);
    const now = S.ctx.currentTime;
    if (S.cast.t < now + 0.05 || S.cast.t > now + 1.2) S.cast.t = now + 0.25; // Puffer gegen Schwankungen
    src.start(S.cast.t);
    S.cast.t += ab.duration;
  }
}

function renderLive() {
  const show = isShow() && S.state?.phase === 'playing';
  $('#live-card').hidden = !show || !S.cast.want;
  $('#live-offer').hidden = !show || S.cast.want;
  $('#live-wait').hidden = S.cast.frames > 0;
  $('#live-img').hidden = !S.cast.frames;
  $('#btn-live-sound').textContent = S.cast.sound ? 'Ton aus' : 'Ton an';
}

function setLive(on) {
  S.cast.want = on;
  if (!on) { S.cast.sound = false; S.cast.frames = 0; }
  try { localStorage.setItem('vp:live', on ? 'on' : 'off'); } catch {}
  syncLive();
  renderLive();
}

$('#btn-live-off').addEventListener('click', () => setLive(false));
$('#btn-live-on').addEventListener('click', () => setLive(true));
$('#btn-live-sound').addEventListener('click', async () => {
  S.cast.sound = !S.cast.sound;
  if (S.cast.sound && S.ctx?.state === 'suspended') await S.ctx.resume().catch(() => {});
  renderLive();
});

/* ================= Anzeige ================= */

const pname = (id) => S.state?.players.find((p) => p.id === id)?.name || 'Offen';

function showView(name) {
  for (const v of ['join', 'lobby', 'game', 'end', 'dub']) $('#view-' + v).hidden = v !== name;
  const leave = document.querySelector('.page-leave');   // legt der Abschnitt „Raum verlassen“ an
  if (leave) leave.hidden = name === 'join' || !S.joined;
}

/* ================= Raum verlassen ================= */
// Unten bei Sprache und Stil. Meldet ab (sonst bleibt man als getrennter Spieler im Raum) und gibt das Mikro frei.
const leaveBtn = document.createElement('button');
leaveBtn.type = 'button';
leaveBtn.className = 'page-pill page-leave';
leaveBtn.textContent = 'Raum verlassen';
leaveBtn.hidden = true;
document.querySelector('.page-tools')?.appendChild(leaveBtn);
leaveBtn.onclick = () => {
  if (!S.joined || !confirm(tr('Raum wirklich verlassen? Du bist dann nicht mehr dabei.'))) return;
  try { S.ws?.send(JSON.stringify({ type: 'leave' })); } catch {}
  S.joined = false;
  store(S.code, null);
  try { S.ws?.close(1000, 'leave'); } catch {}
  S.stream?.getTracks().forEach((tk) => tk.stop());
  S.stream = null;
  if (player) player.pause();
  history.replaceState(null, '', location.pathname);
  showView('join');
  toast(tr('Du hast den Raum verlassen.'));
};

function render() {
  const st = S.state;
  if (!S.joined || !st) return showView('join');
  if (window.Dub?.handles(st)) return Dub.render();
  if (st.phase === 'lobby') {
    showView('lobby');
    isShow() ? renderShowLobby() : renderLobby();
  } else if (st.phase === 'playing') {
    showView('game');
    isShow() ? renderShowGame() : renderGame();
    renderLive();
  } else {
    showView('end');
    isShow() ? renderShowEnd() : renderEnd();
  }
}

/* ---------- Gameshow ---------- */

function renderShowLobby() {
  const st = S.state;
  $('#lobby-code').textContent = st.code;
  $('#lobby-me').textContent = st.me?.name || '';
  $('#mode-title').textContent = 'Gameshow';
  $('#mode-text').textContent = 'Jede Runde bekommst du einen Clip. Hör ihn dir an und sprich ihn so genau wie möglich nach. Das Spiel am PC vergibt die Punkte.';
  $('#claim-grid').hidden = true;
  $('#order-list').hidden = true;
  $('#dl-card').hidden = true;
  $('#player-list').replaceChildren(...st.players.map(playerRow));
  $('#lobby-wait').textContent = 'Warte, bis der PC die Show startet';
}

function renderShowGame() {
  const st = S.state;
  const sh = st.show;
  const r = sh.round;
  const turn = curTurn();
  const mine = turn && turn.playerId === S.playerId;
  $('#game-code').textContent = st.code;
  $('#game-count').textContent = r ? `Runde ${r.index + 1} von ${r.total}` : '';
  const sent = mine && (r.done.includes(S.playerId) || ['sending', 'sent'].includes(S.rec?.turnId === r.roundId && S.rec.phase));
  const title = r ? S.clipsById[r.clipId]?.title || '' : '';
  if (!st.hostOnline) {
    // Spiel am PC abgestürzt oder geschlossen: nicht ewig auf die nächste Runde warten lassen
    $('#now-who').textContent = 'Verbindung zum PC unterbrochen. Warte, bis er wieder da ist …';
    $('#now-clip').textContent = '';
  } else if (mine && !sent) {
    $('#now-who').textContent = 'Du bist dran!';
    if (sh.status) $('#now-clip').textContent = `Im Spiel: ${sh.status}`;
    else $('#now-clip').replaceChildren(nameNode(title));
  } else if (r && !mine) {
    // Wer erst während der Show beitritt, ist nicht im Spiel und schaut nur zu
    $('#now-who').textContent = sh.status || 'Die anderen sind dran';
    $('#now-clip').textContent = 'Du schaust dieser Runde zu.';
  } else {
    $('#now-who').textContent = sh.status || (!r ? 'Gleich geht es los' : 'Warte auf die Bewertung');
    $('#now-clip').replaceChildren(nameNode(title));
  }
  renderTurn();

  const scores = sh.scores || [];
  const me = scores.find((x) => x.playerId === S.playerId);
  $('#result-box').hidden = !scores.length;
  if (scores.length) {
    const pts = (n) => (n == null ? '' : n === 1 ? '1 Punkt' : `${n} Punkte`);
    $('#result-main').textContent = me ? pts(me.score) : '';
    const parts = ['Gesamt:'];
    scores.forEach((x, i) => {
      parts.push(i ? ' · ' : ' ', x.playerId === S.playerId ? 'Du' : nameNode(x.name), ' ', pts(x.total));
    });
    $('#result-sub').replaceChildren(...parts);
  }
  $('#next-mine').textContent = '';
}

function renderShowEnd() {
  const ranking = S.state.show.ranking || [];
  $('#end-title').textContent = ranking.length ? 'Rangliste' : 'Der PC hat die Runde beendet.';
  $('#end-hint').hidden = !!S.state.closed; // Raum geschlossen: keine neue Runde mehr
  $('#end-list').replaceChildren(
    ...ranking.map((x) => {
      const li = document.createElement('li');
      if (x.playerId === S.playerId) li.className = 'me';
      const a = document.createElement('span');
      a.append(`${x.place}. `, nameNode(x.name, x.playerId === S.playerId ? '(du)' : ''));
      const b = document.createElement('span');
      b.className = 'tag ok';
      b.textContent = x.total == null ? '' : `${x.total} P.`;
      li.append(a, b);
      return li;
    })
  );
}

function renderLobby() {
  const st = S.state;
  $('#dl-card').hidden = false;
  $('#lobby-code').textContent = st.code;
  $('#lobby-me').textContent = st.me?.name || '';

  const claim = st.settings.mode === 'claim';
  $('#mode-title').textContent = claim ? 'Charaktere claimen' : 'Der Reihe nach';
  $('#mode-text').textContent = claim
    ? 'Wähl die Charaktere, die du sprechen willst. Du bekommst dann alle ihre Clips.'
    : 'Alle Clips kommen nacheinander, ihr wechselt euch in dieser Reihenfolge ab.';

  const grid = $('#claim-grid');
  grid.hidden = !claim;
  grid.replaceChildren(
    ...(claim ? st.characters : []).map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      const mine = c.claimedBy === S.playerId;
      const taken = c.claimedBy && !mine;
      b.className = 'claim' + (mine ? ' mine' : '') + (taken ? ' taken' : '');
      b.disabled = !!taken;
      b.setAttribute('aria-pressed', String(mine));
      b.innerHTML = `<strong></strong><span></span>`;
      b.querySelector('strong').textContent = c.name;
      b.querySelector('strong').setAttribute('data-nolang', '');
      if (taken) b.querySelector('span').replaceChildren(nameNode(pname(c.claimedBy)));
      else b.querySelector('span').textContent = mine ? `Deins, ${c.clipCount} Clips` : `${c.clipCount} Clips, frei`;
      b.onclick = () => wsSend({ type: 'claim.toggle', character: c.name });
      return b;
    })
  );

  const order = $('#order-list');
  order.hidden = claim;
  order.replaceChildren(
    ...(claim ? [] : st.players).map((p) => {
      const li = document.createElement('li');
      li.append(nameNode(p.name, p.kind === 'local' ? '(am PC)' : ''));
      if (p.id === S.playerId) li.className = 'me';
      return li;
    })
  );

  const need = S.myQueue.length;
  const have = S.myQueue.filter((id) => DL.cache.has(id)).length;
  $('#dl-count').textContent = need ? `${have} von ${need}` : '';
  $('#dl-bar').style.width = need ? `${(have / need) * 100}%` : '0%';
  $('#dl-text').textContent = !need
    ? claim ? 'Noch keine Clips. Claim einen Charakter.' : 'Warte auf Clips vom PC.'
    : have === need ? 'Alles geladen.' : st.settings.preload ? 'Wird vorgeladen. Das Spiel startet, wenn alle fertig sind.' : 'Lädt im Hintergrund weiter, auch während des Spiels.';

  $('#player-list').replaceChildren(...st.players.map(playerRow));

  const cs = st.canStart;
  $('#lobby-wait').textContent =
    cs.reason === 'preloading' ? `Warte, bis alle ihre Clips geladen haben (${cs.waiting.length} noch dabei)` :
    cs.reason === 'clips_uploading' ? 'Der PC lädt gerade die Clips hoch …' :
    'Warte auf den Start am PC';
}

function playerRow(p) {
  const li = document.createElement('li');
  const n = document.createElement('span');
  n.append(nameNode(p.name, p.id === S.playerId ? '(du)' : ''));
  const t = document.createElement('span');
  t.className = 'tag';
  if (p.kind === 'local') t.textContent = 'am PC';
  else if (!p.connected) { t.textContent = 'getrennt'; t.className += ' off'; }
  else if (isShow()) { t.textContent = 'dabei'; t.className += ' ok'; }
  else if (p.progress.ready) { t.textContent = 'bereit'; t.className += ' ok'; }
  else t.textContent = `lädt ${p.progress.have}/${p.progress.need}`;
  li.append(n, t);
  return li;
}

function renderGame() {
  const st = S.state;
  $('#game-code').textContent = st.code;
  const turn = st.turn;
  $('#game-count').textContent = turn ? `Clip ${turn.index + 1} von ${st.schedule.length}` : '';

  if (turn) {
    const clip = S.clipsById[turn.clipId];
    const mine = turn.playerId === S.playerId;
    $('#now-who').textContent = mine ? 'Du bist dran!' : turn.playerId ? `${pname(turn.playerId)} ist dran` : 'Offener Clip';
    $('#now-clip').replaceChildren(nameNode(clip ? `${clip.character}: ${clip.title}` : ''));
  } else {
    $('#now-who').textContent = 'Gleich geht es los';
    $('#now-clip').textContent = '';
  }
  renderTurn();

  const r = S.lastResult;
  $('#result-box').hidden = !r;
  if (r) {
    $('#result-main').textContent = r.grade || (r.score != null ? String(r.score) : r.skipped ? 'Übersprungen' : '');
    $('#result-sub').replaceChildren(nameNode(pname(r.playerId)), ...(r.text ? [': ', r.text] : []));
  }

  const nextIdx = st.schedule.findIndex((e) => e.index > st.cursor && e.playerId === S.playerId);
  if (nextIdx >= 0 && !(turn && turn.playerId === S.playerId)) {
    const e = st.schedule[nextIdx];
    const inN = e.index - st.cursor;
    const c = S.clipsById[e.clipId];
    $('#next-mine').replaceChildren(
      'Dein nächster Clip:', ' ', nameNode(c?.title || ''), ' · ',
      inN === 1 ? 'als Nächstes' : `in ${inN} Runden`, ' · ',
      DL.cache.has(e.clipId) ? 'geladen' : 'lädt noch'
    );
  } else $('#next-mine').textContent = '';
}

function renderTurn() {
  renderVoiceCard();
  const turn = curTurn();
  const box = $('#turn-box');
  const mine = turn && turn.playerId === S.playerId;
  box.hidden = !mine;
  if (!mine) return;

  const orb = $('#orb');
  const label = $('#orb-label');
  const status = $('#turn-status');
  const rec = S.rec && S.rec.turnId === turn.turnId ? S.rec : null;
  const cached = DL.cache.has(turn.clipId);
  const show = turn.show;
  const doneBefore = show && !rec && show.done.includes(S.playerId); // z. B. nach Neuladen der Seite
  $('#btn-stop').hidden = rec?.phase !== 'recording';
  label.classList.remove('big');
  orb.className = 'orb';

  if (rec?.phase === 'countdown') {
    orb.classList.add('ready');
    label.classList.add('big');
    label.textContent = rec.n;
    status.textContent = 'Gleich geht die Aufnahme los';
  } else if (rec?.phase === 'recording') {
    orb.classList.add('recording');
    status.textContent = 'Aufnahme läuft, leg los!';
  } else if (rec?.phase === 'sending') {
    orb.classList.add('sending');
    label.textContent = 'Sende …';
    status.textContent = 'Deine Aufnahme geht an den PC';
  } else if (show && (rec?.phase === 'sent' || doneBefore)) {
    orb.classList.add('ready');
    label.textContent = 'Gesendet';
    status.textContent = 'Das Spiel bewertet dich, sobald du dran bist.';
  } else if (rec?.phase === 'sent' && S.lastResult?.turnId === turn.turnId) {
    orb.classList.add('ready');
    label.classList.add('big');
    label.textContent = S.lastResult.grade || S.lastResult.score || '✓';
    status.textContent = 'Bewertung ist da. Gleich geht es weiter.';
  } else if (rec?.phase === 'sent') {
    orb.classList.add('ready');
    label.textContent = 'Gesendet';
    status.textContent = 'Der PC bewertet dich gerade';
  } else if (rec?.phase === 'error') {
    orb.classList.add('loading');
    label.textContent = 'Fehler';
    status.textContent = (rec.error || 'Etwas ist schiefgelaufen') + (show ? ' Tipp nochmal, um es neu zu versuchen.' : '');
  } else if (!cached) {
    orb.classList.add('loading');
    const pct = Math.round((DL.progress[turn.clipId] || 0) * 100);
    label.textContent = pct + ' %';
    status.textContent = 'Dein Clip lädt noch. Die anderen warten kurz.';
  } else if (show) {
    orb.classList.add('ready');
    label.classList.add('big');
    label.textContent = 'Los';
    status.textContent = 'Hör dir den Clip an. Tipp auf Los, wenn du bereit bist. Nach dem Countdown sprichst du ihn nach.';
  } else {
    orb.classList.add('ready');
    label.textContent = 'Bereit';
    status.textContent = 'Hör dir den Clip an. Der PC startet gleich deine Aufnahme.';
  }
}

function renderEnd() {
  const st = S.state;
  $('#end-title').textContent = 'Deine Runden';
  $('#end-hint').hidden = !!st.closed;
  const mine = st.results.filter((r) => r.playerId === S.playerId);
  $('#end-list').replaceChildren(
    ...mine.map((r) => {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = S.clipsById[r.clipId]?.title || r.clipId;
      const b = document.createElement('span');
      b.className = 'tag ok';
      b.textContent = r.skipped ? 'übersprungen' : r.grade || (r.score ?? '');
      li.append(a, b);
      return li;
    })
  );
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

// Automatisch wieder rein, wenn man schon in diesem Raum war
if (S.code && stored(S.code)?.token && $('#join-name').value) {
  $('#join-error').textContent = 'Tipp auf Beitreten, um wieder reinzukommen.';
  $('#join-error').hidden = false;
}
