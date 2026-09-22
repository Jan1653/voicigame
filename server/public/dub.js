'use strict';
/* =====================================================================
 * Dub-Modus (Synchronisieren) im Browser.
 *
 * Nutzt die Grundlage aus app.js (Verbindung S, wsSend, toast, Stimm-Analyse analyze/scoreTake).
 * Ablauf wie im Spiel und im Steam-Mehrspieler:
 *   Lobby     Pack hochladen (Spielleitung), Figuren claimen, der Reihe nach, Pack laden, Start
 *   Studio    Fernseher mit Bild der Zeile, Untertitel, Wellenform; wer dran ist: anhören, aufnehmen, weiter
 *   Ergebnis  Wertung, gemeinsam anschauen (zeitgleich auf allen Geräten), Video exportieren, Aufnahmen als ZIP
 * ===================================================================== */
(() => {
  const t = window.t || ((s) => s);
  const OPTS_KEY = 'vp:dubopts';
  const SR = 44100;
  const FPS = 60;
  const VISIBLE_S = 6.3;          // Ersatzlänge, solange die Clip-Länge noch unbekannt ist
  const SNAP_S = 0.012;           // Versatz unter diesem Wert gilt als „synchron“ (wie im Steam-Mod)

  const D = {
    built: false,
    view: null,
    version: -1,
    pack: null,
    packLoading: null,
    files: new Map(),             // url -> Blob
    buffers: new Map(),           // url -> AudioBuffer (die letzten paar)
    analysis: new Map(),          // url -> Wellenform-Daten
    takeBlobs: new Map(),         // clipId|pid|v -> Blob
    queue: [],
    busy: 0,
    turnKey: '',
    mine: false,
    mode: 'idle',                 // idle | first | listen | record | synced | send | sent
    take: null,                   // {pcm, rate, an}
    attempts: 0,
    offset: 0,
    drawUntil: 0,                 // bis wohin die Clip-Wellenform schon gezeichnet ist (erstes Anhören)
    playhead: null,
    live: null,                   // Live-Wellenform beim Aufnehmen
    player: null,                 // laufende Wiedergabe {stop()}
    rec: null,
    clock: { offset: 0, rtt: Infinity },
    watch: null,
    watchId: null,
    expanded: false,
    resultsFor: -1,
    mic: null,
    worklet: false,
    opts: loadOpts(),
    phaseShown: '',
    screen: '',
    lastChat: 0,
    uploading: null,
  };

  window.Dub = {
    handles: (st) => !!(st && st.game === 'dub' && st.dub),
    render,
    onMessage,
    createRoom,
    debug: () => D, // für Tests und Fehlersuche
  };

  /* ================= Kleinigkeiten ================= */

  /** Handy oder Tablet: der Lautsprecher ist nah am Mikro, was läuft, landet in der Aufnahme. */
  // Funktion statt const: loadOpts() läuft schon beim Laden, weiter oben in dieser Datei
  function isPhone() {
    return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  function loadOpts() {
    const def = { muteClip: false, noCaptions: false, oneTake: false, muteBacking: false, clipVol: 0.33, backVol: 1, quietRec: isPhone() };
    try { return { ...def, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return def; }
  }
  function saveOpts() {
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(D.opts)); } catch {}
  }
  const $d = (s) => document.querySelector('#view-dub ' + s);
  const auth = (url) => url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(S.token || '');
  const dv = () => S.state?.dub || null;
  const pname = (id) => S.state?.players?.find((p) => p.id === id)?.name || dv()?.takes?.find((x) => x.playerId === id)?.name || t('Jemand');
  const isLeader = () => !!dv()?.me?.leader;
  const clipById = (id) => D.pack?.clips.find((c) => c.id === id) || null;
  const fmtS = (s) => (Math.abs(s) < SNAP_S ? t('Synchron') : `${s > 0 ? '+' : ''}${s.toFixed(2)} s`);

  /** Nur neu aufbauen, wenn sich etwas geändert hat (sonst gehen Klicks und Dateiauswahl verloren). */
  function same(box, sig) {
    if (box.dataset.sig === sig) return true;
    box.dataset.sig = sig;
    return false;
  }

  function node(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /** Ton, den dieser Browser nicht abspielen kann (Ogg auf älteren iPhones), holt sich die Seite als MP3. */
  let OGG_OK = null;
  function audioUrl(u) {
    if (OGG_OK === null) {
      const a = document.createElement('audio');
      OGG_OK = !!a.canPlayType && a.canPlayType('audio/ogg; codecs="vorbis"') !== '';
    }
    const needs = /\.(ogg|opus|flac)$/i.test(decodeURIComponent(u)) && !OGG_OK && dv()?.ffmpeg;
    return auth(u + (needs ? '?fmt=mp3' : ''));
  }

  /* ================= Uhr abgleichen (für gemeinsames Anschauen) ================= */

  let clockTimer = null;
  function syncClock() {
    D.clock.rtt = Infinity;
    for (let i = 0; i < 5; i++) setTimeout(() => wsSend({ type: 'dub.time', t: Date.now() }), i * 250);
  }
  const serverNow = () => Date.now() + D.clock.offset;

  /* ================= Pack laden ================= */

  async function ensurePack(d) {
    if (!d.pack || d.packStatus?.status !== 'ready') {
      if (d.version !== D.version) { D.pack = null; D.version = d.version; }
      return;
    }
    if (D.version === d.version && D.orderVersion === d.orderVersion && (D.pack || D.packLoading)) return;
    if (D.packLoading) return;
    const fresh = D.version !== d.version;
    D.version = d.version;
    D.orderVersion = d.orderVersion;
    if (fresh) {
      D.pack = null;
      D.files.clear();
      D.buffers.clear();
      D.analysis.clear();
      for (const u of objUrls.values()) URL.revokeObjectURL(u);
      objUrls.clear();
    }
    const v = d.version;
    D.packLoading = (async () => {
      const res = await fetch(auth(`/api/rooms/${S.code}/dub/pack.json`));
      const j = await res.json();
      if (j.version !== v || !j.pack) return;
      D.pack = j.pack;
      D.orderVersion = j.orderVersion;
      // Kommt das Pack aus dem Spiel, sind am Anfang noch nicht alle Zeilen da (ready = false).
      // Geholt wird nur, was da ist; der Rest kommt mit der nächsten Fassung nach.
      const urls = [];
      for (const c of j.pack.clips) {
        if (c.ready === false) continue;
        if (c.audio) urls.push(c.audio);
        if (c.image) urls.push(c.image);
      }
      if (j.pack.backing) urls.push(j.pack.backing);
      if (j.pack.icon) urls.push(j.pack.icon);
      const want = [...new Set(urls)];
      D.need = want.length;
      D.queue = want.filter((u) => !D.files.has(u));
      reportReady();
      pump();
      render();
    })().catch((e) => { console.warn('Pack', e); D.version = -1; }).finally(() => { D.packLoading = null; if (dv() && (dv().version !== D.version || dv().orderVersion !== D.orderVersion)) ensurePack(dv()); });
  }

  function reportReady() {
    const have = D.pack ? [...D.files.keys()].length : 0;
    wsSend({ type: 'dub.ready', have: Math.min(have, D.need || 0), need: D.need || 0, version: D.version });
  }

  function prioritize(urls) {
    const want = urls.filter((u) => u && !D.files.has(u));
    D.queue = want.concat(D.queue.filter((u) => !want.includes(u)));
    pump();
  }

  function pump() {
    while (D.busy < 3 && D.queue.length) {
      const u = D.queue.shift();
      if (D.files.has(u)) continue;
      D.busy++;
      const version = D.version;
      fetchBlob(u).then((b) => {
        if (version !== D.version) return;
        D.files.set(u, b);
        const n = D.files.size;
        if (n === D.need || n % 3 === 0) reportReady();
        if (n === D.need) render();
      }).catch(async () => {
        await sleep(1500);
        if (version === D.version) D.queue.push(u);
      }).finally(() => { D.busy--; pump(); });
    }
  }

  async function fetchBlob(u) {
    const r = await fetch(/\.(ogg|opus|flac|wav|mp3|m4a|aac)$/i.test(decodeURIComponent(u)) ? audioUrl(u) : auth(u));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }

  const objUrls = new Map();
  function blobUrl(u) {
    if (!u) return '';
    const b = D.files.get(u);
    if (!b) return auth(u);
    if (!objUrls.has(u)) objUrls.set(u, URL.createObjectURL(b));
    return objUrls.get(u);
  }

  /* ================= Ton ================= */

  async function getBuffer(u) {
    if (D.buffers.has(u)) return D.buffers.get(u);
    let blob = D.files.get(u);
    if (!blob) { prioritize([u]); blob = await fetchBlob(u); D.files.set(u, blob); }
    const buf = await S.ctx.decodeAudioData(await blob.arrayBuffer());
    D.buffers.set(u, buf);
    if (D.buffers.size > 10) D.buffers.delete(D.buffers.keys().next().value);
    return buf;
  }

  /** Wellenform wie im Spiel: je 1/60 s mittlere und größte Lautstärke, dazu Tonhöhe als Punkte. */
  function waveData(pcm, rate) {
    const step = rate / FPS;
    const n = Math.max(1, Math.floor(pcm.length / step));
    const avg = new Float32Array(n), max = new Float32Array(n);
    let top = 1e-6;
    for (let i = 0; i < n; i++) {
      let e = 0, m = 0;
      const a = Math.floor(i * step), b = Math.min(pcm.length, Math.floor((i + 1) * step));
      for (let j = a; j < b; j++) { const v = Math.abs(pcm[j]); e += v * v; if (v > m) m = v; }
      avg[i] = Math.sqrt(e / Math.max(1, b - a));
      max[i] = m;
      if (m > top) top = m;
    }
    let pitch = null;
    try { pitch = analyze(pcm, rate); } catch {}
    return { ...smooth(avg, max), top, duration: pcm.length / rate, pitch };
  }

  /** Wie die Spektrum-Anzeige im Spiel: weich, leicht zusammengedrückt (Wurzel), außen dunkel, innen hell. */
  function smooth(avg, max) {
    const n = avg.length;
    const a = new Float32Array(n), m = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, w = 0, mm = 0;
      for (let k = -3; k <= 3; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        const wt = 4 - Math.abs(k);
        s += avg[j] * wt;
        w += wt;
        if (Math.abs(k) <= 1) mm = Math.max(mm, max[j]);
      }
      a[i] = s / w;
      m[i] = mm;
    }
    return { avg: a, max: m };
  }

  async function clipAnalysis(u) {
    if (D.analysis.has(u)) return D.analysis.get(u);
    const buf = await getBuffer(u);
    const a = waveData(mixDown(buf), buf.sampleRate);
    D.analysis.set(u, a);
    return a;
  }

  function stopPlayer() {
    if (D.player) { try { D.player.stop(); } catch {} }
    D.player = null;
  }

  /** Clip (und evtl. eigene Aufnahme) abspielen, Abspielposition mitführen. */
  function playBuffers(list, onEnd) {
    stopPlayer();
    const ctx = S.ctx;
    const t0 = ctx.currentTime + 0.06;
    const nodes = [];
    let longest = 0;
    let last = null;
    for (const it of list) {
      if (!it.buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = it.buf;
      const g = ctx.createGain();
      g.gain.value = it.gain ?? 1;
      src.connect(g).connect(ctx.destination);
      const when = t0 + Math.max(0, it.at || 0);
      const skip = Math.max(0, -(it.at || 0));
      src.start(when, skip);
      const end = (it.at || 0) + it.buf.duration;
      if (end >= longest) { longest = end; last = src; }
      nodes.push(src);
    }
    let stopped = false;
    // Ende über das Ereignis der Tonquelle: requestAnimationFrame steht still, solange die Seite nicht sichtbar ist
    const finish = () => {
      if (stopped || D.player !== p) return;
      stopped = true;
      D.player = null;
      D.playhead = null;
      drawWave();
      onEnd?.();
    };
    if (last) last.onended = finish;
    else setTimeout(finish, 50);
    const p = {
      t0,
      stop() {
        if (stopped) return;
        stopped = true;
        for (const n of nodes) { try { n.stop(); } catch {} }
        D.playhead = null;
        drawWave();
      },
    };
    D.player = p;
    const tick = () => {
      if (stopped || D.player !== p) return;
      const el = ctx.currentTime - t0;
      D.playhead = Math.min(Math.max(0, el), longest);
      if (D.mode === 'first') D.drawUntil = Math.max(D.drawUntil, el);
      drawWave();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return p;
  }

  /* ================= Mikrofon und Aufnahme ================= */

  async function dubMic() {
    if (D.mic && D.mic.getAudioTracks().some((x) => x.readyState === 'live')) return D.mic;
    try {
      // Echo-Unterdrückung an: läuft der Clip über den Lautsprecher, landet er so nicht in der Aufnahme
      D.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
      S.stream = D.mic;
    } catch {
      await ensureMic();
      D.mic = S.stream;
    }
    D.src = null;
    return D.mic;
  }

  async function recorderNode() {
    const ctx = S.ctx;
    if (D.recNode && D.recStream === D.mic) return D.recNode;
    if (!D.src || D.recStream !== D.mic) {
      D.src = ctx.createMediaStreamSource(D.mic);
      D.recStream = D.mic;
    }
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let nodeRec;
    if (ctx.audioWorklet && !D.noWorklet) {
      try {
        if (!D.worklet) { await ctx.audioWorklet.addModule('dub-worklet.js'); D.worklet = true; }
        nodeRec = new AudioWorkletNode(ctx, 'dub-recorder');
        nodeRec.port.onmessage = (e) => D.onChunk?.(e.data.frame, e.data.data);
        nodeRec.setOn = (on) => nodeRec.port.postMessage({ on });
      } catch (e) {
        console.warn('AudioWorklet nicht verfügbar', e);
        D.noWorklet = true;
      }
    }
    if (!nodeRec) {
      nodeRec = ctx.createScriptProcessor(2048, 1, 1);
      let on = false;
      nodeRec.onaudioprocess = (e) => {
        if (!on) return;
        const frame = Math.round(e.playbackTime * ctx.sampleRate);
        D.onChunk?.(frame, new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      nodeRec.setOn = (v) => { on = v; };
    }
    D.src.connect(nodeRec);
    nodeRec.connect(sink);
    D.recNode = nodeRec;
    return nodeRec;
  }

  function latency(ctx) {
    const out = Number.isFinite(ctx.outputLatency) && ctx.outputLatency > 0 ? ctx.outputLatency : ctx.baseLatency || 0.02;
    const set = D.mic?.getAudioTracks()[0]?.getSettings?.() || {};
    const inp = Number.isFinite(set.latency) && set.latency > 0 ? set.latency : 0.01;
    return Math.min(0.5, out + inp);
  }

  /** Clip abspielen und gleichzeitig aufnehmen, so wie im Spiel. Die Aufnahme beginnt genau mit dem Clip. */
  async function record(clip) {
    if (D.mode === 'record') return;
    stopPlayer();
    const ctx = S.ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    try {
      await dubMic();
    } catch (e) {
      toast(t('Ohne Mikrofon kannst du nicht aufnehmen.'));
      return;
    }
    const buf = await getBuffer(clip.audio);
    const recNode = await recorderNode();
    const rate = ctx.sampleRate;
    const len = Math.round(buf.duration * rate);
    const pcm = new Float32Array(len);
    const t0 = ctx.currentTime + 0.16;
    const first = Math.round((t0 + latency(ctx)) * rate);
    let got = 0;
    D.mode = 'record';
    D.take = null;
    D.offset = 0;
    D.live = { avg: [], max: [], pitch: [], top: 0.05 };
    const frameLen = rate / FPS;
    let acc = 0, accE = 0, accM = 0;
    D.onChunk = (frame, data) => {
      for (let i = 0; i < data.length; i++) {
        const pos = frame + i - first;
        if (pos < 0 || pos >= len) continue;
        pcm[pos] = data[i];
        got = Math.max(got, pos + 1);
        const v = Math.abs(data[i]);
        accE += v * v;
        if (v > accM) accM = v;
        if (++acc >= frameLen) {
          D.live.avg.push(Math.sqrt(accE / acc));
          D.live.max.push(accM);
          D.live.top = Math.max(D.live.top, accM);
          acc = 0; accE = 0; accM = 0;
        }
      }
    };
    recNode.setOn(true);
    // Beim Aufnehmen still (am Handy Standard): sonst nimmt das Mikro die Originalstimme mit auf
    const player = playBuffers([{ buf, gain: D.opts.muteClip || D.opts.quietRec ? 0 : D.opts.clipVol }], null);
    wsSend({ type: 'dub.activity', what: 'record' });
    renderRemote();
    const done = new Promise((resolve) => {
      D.rec = { stop: resolve };
      const check = () => {
        if (D.mode !== 'record') return resolve();
        if (got >= len || ctx.currentTime > t0 + buf.duration + latency(ctx) + 0.3) return resolve();
        setTimeout(check, 50);
      };
      check();
    });
    await done;
    recNode.setOn(false);
    D.onChunk = null;
    player.stop();
    D.rec = null;
    D.attempts++;
    const take = pcm.subarray(0, Math.max(got, 1));
    D.take = { pcm: take, rate, an: waveData(take, rate) };
    D.live = null;
    D.mode = 'idle';
    wsSend({ type: 'dub.activity', what: 'review' });
    renderRemote();
    drawWave();
  }

  /** Aufnahme mit Versatz auf Clip-Länge bringen, auf 44,1 kHz umrechnen, als WAV. */
  async function finalTake(clipBuf) {
    const { pcm, rate } = D.take;
    const len = Math.round(clipBuf.duration * rate);
    const out = new Float32Array(len);
    const shift = Math.round(D.offset * rate);
    for (let i = 0; i < len; i++) {
      const j = i - shift;
      if (j >= 0 && j < pcm.length) out[i] = pcm[j];
    }
    let mono = out;
    if (rate !== SR) {
      const off = new OfflineAudioContext(1, Math.max(1, Math.round(len * SR / rate)), SR);
      const b = off.createBuffer(1, len, rate);
      b.copyToChannel(out, 0);
      const s = off.createBufferSource();
      s.buffer = b;
      s.connect(off.destination);
      s.start();
      mono = (await off.startRendering()).getChannelData(0);
    }
    const bytes = new ArrayBuffer(44 + mono.length * 2);
    const v = new DataView(bytes);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + mono.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, mono.length * 2, true);
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return { blob: new Blob([bytes], { type: 'audio/wav' }), pcm: mono };
  }

  async function sendTake(clip) {
    if (!D.take || D.mode === 'send') return;
    D.mode = 'send';
    renderRemote();
    try {
      const clipBuf = await getBuffer(clip.audio);
      const { blob, pcm } = await finalTake(clipBuf);
      let score = null;
      try {
        const target = analyze(mixDown(clipBuf), clipBuf.sampleRate);
        score = scoreTake(target, analyze(pcm, SR));
      } catch {}
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        const r = await fetch(auth(`/api/rooms/${S.code}/dub/takes/${encodeURIComponent(clip.id)}`), {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav', ...(score ? { 'X-Phone-Score': JSON.stringify(score) } : {}) },
          body: blob,
        });
        if (r.status === 409) throw new Error((await r.json().catch(() => ({}))).error || t('Diese Zeile ist schon vorbei.'));
        ok = r.ok;
        if (!ok) await sleep(800);
      }
      if (!ok) throw new Error(t('Senden fehlgeschlagen'));
      D.mode = 'sent';
    } catch (e) {
      D.mode = 'idle';
      toast(t(e.message || String(e)));
    }
    renderRemote();
  }

  /* ================= Rauschen zwischen den Zeilen ================= */

  let noiseRaf = 0;
  function noise(on) {
    const cv = $d('.dub-static');
    if (!cv) return;
    cv.hidden = !on;
    cancelAnimationFrame(noiseRaf);
    if (!on) return;
    const g = cv.getContext('2d');
    cv.width = 198; cv.height = 100;
    const img = g.createImageData(cv.width, cv.height);
    let last = 0;
    const step = (ts) => {
      if (cv.hidden) return;
      if (ts - last > 40) {
        last = ts;
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = 60 + Math.random() * 120;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
        g.putImageData(img, 0, 0);
      }
      noiseRaf = requestAnimationFrame(step);
    };
    noiseRaf = requestAnimationFrame(step);
  }

  /* ================= Wellenform ================= */

  function css(name) {
    return getComputedStyle($d('.dub-studio')).getPropertyValue(name).trim() || '#fff';
  }

  function drawWave() {
    const cv = $d('.dub-wave canvas');
    if (!cv || !cv.offsetParent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const clip = currentClip();
    const an = clip ? D.analysis.get(clip.audio) : null;
    const dur = an?.duration || clip?.duration || VISIBLE_S;
    // Wie im Spiel: der Kasten ist genau so lang wie der Clip, hinten kein leeres Stück
    const pps = w / Math.max(0.5, dur + 0.05);
    D.pps = pps;
    const mid = h / 2;
    const half = h / 2 - 4;

    const bars = (data, until, colIn, colOut, shift) => {
      const n = Math.min(data.avg.length, Math.floor(until * FPS));
      const top = Math.max(data.top, 0.02);
      const bw = Math.max(1, pps / FPS + 0.6);
      const outer = (i) => Math.sqrt(Math.min(1, data.max[i] / top)) * half * 0.9;
      const inner = (i) => Math.min(outer(i) * 0.86, Math.sqrt(Math.min(1, (data.avg[i] * 2.2) / top)) * half * 0.9 * 0.8);
      g.fillStyle = colOut;
      for (let i = 0; i < n; i++) {
        const a = outer(i);
        if (a > 1.5) g.fillRect((i / FPS + shift) * pps, mid - a, bw, a * 2);
      }
      g.fillStyle = colIn;
      for (let i = 0; i < n; i++) {
        const a = inner(i);
        if (a > 1.5) g.fillRect((i / FPS + shift) * pps, mid - a, bw, a * 2);
      }
    };
    const dots = (p, until, col, shift) => {
      if (!p) return;
      g.fillStyle = col;
      const band = h * 0.26;
      for (let i = 0; i < p.midi.length; i++) {
        const tt = i * p.hop;
        if (tt > until) break;
        const m = p.midi[i];
        if (isNaN(m)) continue;
        const y = h - 3 - Math.max(0, Math.min(1, (m - 38) / 50)) * band;
        g.fillRect((tt + shift) * pps, y, Math.max(2, pps * p.hop * 0.6), 2);
      }
    };

    if (an) {
      const until = D.shownClipDrawn ? an.duration : D.drawUntil;
      bars(an, until, css('--clip-in'), css('--clip-out'), 0);
      dots(an.pitch, until, css('--clip-pitch'), 0);
    }
    if (D.live) {
      const n = D.live.avg.length;
      const data = { ...smooth(D.live.avg, D.live.max), top: Math.max(0.05, D.live.top) };
      bars(data, n / FPS, css('--take-in'), css('--take-out'), 0);
    } else if (D.take) {
      bars(D.take.an, D.take.an.duration, css('--take-in'), css('--take-out'), D.offset);
      dots(D.take.an.pitch, D.take.an.duration, css('--take-pitch'), D.offset);
    }
    // Mittellinie und Abspielbalken
    g.fillStyle = document.documentElement.dataset.style === 'simple' ? '#2c313c' : '#fff';
    g.fillRect(0, Math.round(mid) - 1, w, 2);
    const ph = D.playhead ?? 0;
    g.fillStyle = css('--playbar');
    g.fillRect(Math.round(ph * pps), 0, Math.max(3, w * 0.004), h);
    const sync = $d('.dub-sync');
    if (sync) {
      sync.hidden = !D.take || !D.mine || D.mode === 'record';
      sync.textContent = fmtS(D.offset);
      sync.title = t('Zieh deine Aufnahme auf der Wellenform nach links oder rechts, wenn sie nicht genau passt.');
    }
  }

  function currentClip() {
    const d = dv();
    const id = d?.turn?.clipId;
    return id ? clipById(id) : null;
  }

  // Aufnahme verschieben: auf der Wellenform ziehen (wie im Steam-Mod)
  function setupDrag() {
    const box = $d('.dub-wave');
    let startX = 0, startOff = 0, drag = false;
    box.addEventListener('pointerdown', (e) => {
      if (!D.take || !D.mine || !['idle'].includes(D.mode)) return;
      drag = true;
      startX = e.clientX;
      startOff = D.offset;
      box.setPointerCapture(e.pointerId);
      box.classList.add('drag');
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const raw = startOff + (e.clientX - startX) / (D.pps || 100);
      D.offset = Math.abs(raw) < SNAP_S ? 0 : Math.max(-1.5, Math.min(1.5, raw));
      drawWave();
    });
    const end = () => { drag = false; box.classList.remove('drag'); };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  /* ================= Gemeinsam anschauen ================= */

  async function prepareWatch() {
    const d = dv();
    if (!D.pack || !d) return null;
    const list = [];
    for (const c of D.pack.clips) {
      if (!c.times.length) continue;
      const takes = c.useAsIs ? [] : d.takes.filter((x) => x.clipId === c.id);
      if (takes.length) {
        for (const x of takes) {
          const buf = await takeBuffer(x).catch(() => null);
          if (buf) list.push({ buf, times: c.times });
        }
      } else if (c.audio) {
        const buf = await getBuffer(c.audio).catch(() => null);
        if (buf) list.push({ buf, times: c.times });
      }
    }
    return list;
  }

  const takeBufs = new Map();
  async function takeBuffer(x) {
    const k = `${x.clipId}|${x.playerId}|${x.v}`;
    if (takeBufs.has(k)) return takeBufs.get(k);
    let blob = D.takeBlobs.get(k);
    if (!blob) {
      const r = await fetch(auth(`/api/rooms/${S.code}/dub/takes/${encodeURIComponent(x.clipId)}/${encodeURIComponent(x.playerId)}`));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await r.blob();
      D.takeBlobs.set(k, blob);
    }
    const buf = await S.ctx.decodeAudioData(await blob.arrayBuffer());
    takeBufs.set(k, buf);
    return buf;
  }

  /** Aufnahmen schon während des Spiels vorladen, damit das Anschauen sofort geht. */
  function preloadTakes(d) {
    for (const x of d.takes || []) {
      const k = `${x.clipId}|${x.playerId}|${x.v}`;
      if (D.takeBlobs.has(k) || D.takeLoading?.has(k)) continue;
      D.takeLoading = D.takeLoading || new Set();
      D.takeLoading.add(k);
      fetch(auth(`/api/rooms/${S.code}/dub/takes/${encodeURIComponent(x.clipId)}/${encodeURIComponent(x.playerId)}`))
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => { if (b) D.takeBlobs.set(k, b); })
        .catch(() => {})
        .finally(() => D.takeLoading.delete(k));
    }
  }

  async function startWatch(atServer, id) {
    stopWatch();
    D.watchId = id;
    const my = { id, stopped: false, sources: [] };
    D.watch = my;
    renderStudio();
    const list = await prepareWatch();
    if (D.watch !== my || !list) return;
    const ctx = S.ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const video = $d('.dub-screen video');
    const back = D.backEl;
    const lead = (atServer - serverNow()) / 1000;
    const t0 = ctx.currentTime + lead;
    my.t0 = t0;
    for (const it of list) {
      for (const ts of it.times) {
        const when = t0 + ts;
        if (when + it.buf.duration < ctx.currentTime) continue;
        const src = ctx.createBufferSource();
        src.buffer = it.buf;
        src.connect(ctx.destination);
        if (when >= ctx.currentTime) src.start(when);
        else src.start(ctx.currentTime, ctx.currentTime - when);
        my.sources.push(src);
      }
    }
    const media = [video, back].filter(Boolean);
    for (const m of media) {
      try { m.pause(); m.currentTime = Math.max(0, -lead); } catch {}
    }
    if (back) {
      back.volume = D.opts.muteBacking ? 0 : Math.min(1, D.opts.backVol);
      back.muted = D.opts.muteBacking;
    }
    const total = Math.max(D.view?.video?.duration || 0, video?.duration || 0) || 600;
    // setInterval statt requestAnimationFrame: läuft auch, wenn die Seite gerade nicht sichtbar ist
    const tick = () => {
      if (D.watch !== my || my.stopped) return clearInterval(my.timer);
      const el = ctx.currentTime - t0;
      if (el >= 0) {
        for (const m of media) {
          if (!m.src) continue;
          if (m.paused && el < (m.duration || total)) m.play().catch(() => {});
          if (Math.abs((m.currentTime || 0) - el) > 0.15 && el < (m.duration || total)) m.currentTime = el;
        }
      }
      if (el > total + 0.4 || (video && video.ended && el > 1)) return stopWatch(true);
    };
    my.timer = setInterval(tick, 100);
    tick();
  }

  function stopWatch(finished = false) {
    const w = D.watch;
    D.watch = null;
    if (w) {
      w.stopped = true;
      clearInterval(w.timer);
      for (const s of w.sources) { try { s.stop(); } catch {} }
    }
    const video = $d('.dub-screen video');
    if (video) { try { video.pause(); } catch {} }
    if (D.backEl) { try { D.backEl.pause(); } catch {} }
    if (finished) D.expanded = false;
    if (w) renderStudio();
  }

  /* ================= Aufbau ================= */

  const SPEAKER = '<svg viewBox="0 0 26 22" aria-hidden="true"><path d="M9 11 L16.5 7.2 A8 8 0 1 0 16.5 14.8 Z" fill="currentColor"/><path d="M19 6 L25 3 M19 11 L25 11 M19 16 L25 19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function build() {
    if (D.built) return;
    D.built = true;
    const root = $('#view-dub');
    root.innerHTML = `
      <div class="dub-backdrop" hidden></div>
      <header class="topbar">
        <span class="room-chip" data-id="code"></span>
        <span class="me-name"><span data-id="me"></span> <span class="dub-lead-tag" data-id="lead" hidden></span></span>
      </header>
      <p class="dub-banner" data-id="notice" hidden></p>

      <section class="dub-hub" data-id="hub">
        <div class="dub-hub-grid">
          <div>
            <div class="glass" data-id="pack-card"></div>
            <div class="glass dub-chars" data-id="chars-card"></div>
          </div>
          <div>
            <div class="glass" data-id="invite-card" hidden></div>
            <div class="glass" data-id="players-card"></div>
            <div class="glass dub-start" data-id="start-card"></div>
            <div class="glass dub-chat" data-id="chat-hub"></div>
          </div>
        </div>
      </section>

      <section class="dub-studio" data-id="studio" hidden>
        <div class="dub-tv">
          <div class="dub-bezel">
            <div class="dub-screen">
              <img alt="" data-id="img">
              <video playsinline muted preload="auto" data-id="video" hidden></video>
              <canvas class="dub-static" hidden></canvas>
              <div class="dub-results" data-id="results" hidden></div>
              <div class="dub-onscreen" data-id="onscreen" hidden><span></span></div>
            </div>
          </div>
          <button type="button" class="cv-pill dub-close-big" data-act="shrink"></button>
        </div>
        <aside class="dub-remote" data-id="remote"></aside>
        <p class="dub-caption" data-id="caption"></p>
        <div class="dub-wave" data-id="wave"><canvas></canvas><span class="dub-sync" hidden></span></div>
        <div class="dub-extra" data-id="extra"></div>
      </section>
      <div class="dub-options" data-id="options" hidden></div>`;
    D.backEl = new Audio();
    D.backEl.preload = 'auto';
    setupDrag();
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    window.addEventListener('resize', () => drawWave());
    window.addEventListener('stylechange', () => { drawWave(); renderResultsScreen(true); });
    syncClock();
    clearInterval(clockTimer);
    clockTimer = setInterval(syncClock, 60000);
  }

  const $id = (id) => $d(`[data-id="${id}"]`);

  /* ================= Anzeige ================= */

  function render() {
    const st = S.state;
    const d = dv();
    if (!d) return;
    build();
    showView('dub');
    D.view = d;
    ensurePack(d);
    preloadTakes(d);
    $id('code').textContent = st.code;
    $id('me').textContent = st.me?.name || '';
    const lead = $id('lead');
    lead.hidden = !d.me?.leader;
    lead.textContent = t('Spielleitung');
    // PC hat den Raum geschlossen oder ist weg (Spiel abgestürzt, Verbindung weg)
    const notice = $id('notice');
    const msg = st.closed ? t('Der PC hat die Runde beendet.')
      : d.source === 'game' && st.hostOnline === false ? t('Verbindung zum PC unterbrochen. Warte, bis er wieder da ist …') : '';
    notice.hidden = !msg;
    notice.textContent = msg;
    const studio = d.phase !== 'hub';
    $id('hub').hidden = studio;
    $id('studio').hidden = !studio;
    document.body.classList.toggle('dub-dark', studio);
    $d('.dub-backdrop').hidden = !studio;
    $('#app').classList.add('dub-wide');
    if (d.phase !== D.phaseShown) {
      D.phaseShown = d.phase;
      if (d.phase === 'hub') { stopWatch(); stopPlayer(); D.turnKey = ''; D.resultsFor = -1; }
    }
    if (studio) renderStudio();
    else renderHub();
    // Anschauen, falls schon gestartet (z. B. nach Neuladen)
    const running = d.watch && serverNow() - d.watch.at < ((d.video?.duration || 600) + 1) * 1000;
    if (running && d.watch.id !== D.watchId && d.phase === 'results') startWatch(d.watch.at, d.watch.id);
    if (!d.watch && D.watch && D.watchId !== 'local') stopWatch();
  }

  /* ---------- Lobby ---------- */

  function renderHub() {
    const d = dv();
    renderPackCard(d);
    renderChars(d);
    renderInvite(d);
    renderPlayers(d);
    renderStart(d);
    renderChat($id('chat-hub'), d);
  }

  function renderPackCard(d) {
    const card = $id('pack-card');
    if (!card.dataset.built) {
      card.dataset.built = '1';
      card.innerHTML = '<div data-id="pack-info"></div><div data-id="pack-upload"></div>';
    }
    renderPackInfo(d, $id('pack-info'));
    renderPackUpload(d, $id('pack-upload'));
  }

  function renderPackInfo(d, box) {
    const ps = d.packStatus || {};
    const video = d.video || {};
    const ready = d.pack && ps.status === 'ready';
    if (same(box, JSON.stringify(['p', d.pack, ps, video.status, Math.round((video.pct || 0) * 50), D.files.size, D.need, !!D.pack, d.source, d.me?.canUpload]))) return;
    let html = '';
    if (ready) {
      const icon = D.pack?.icon ? blobUrl(D.pack.icon) : '';
      html += `<div class="dub-pack">${icon ? `<img alt="" src="${icon}">` : '<span></span>'}<div><h2 data-f="title"></h2><p class="muted" data-f="sub"></p><p class="muted" data-f="load"></p></div></div>`;
      html += '<div class="dub-bar"><span data-f="bar"></span></div>';
      if (video.status === 'converting' || video.status === 'checking') html += '<p class="dub-note" data-f="video"></p>';
      else if (video.status === 'original') html += `<p class="dub-note">${t('Das Video läuft nur in manchen Browsern (auf dem Server fehlt ffmpeg zum Umwandeln).')}</p>`;
    } else {
      html += `<h2>${t('Pack')}</h2>`;
    }
    if (ps.status === 'processing' || ps.status === 'uploading') html += `<p class="dub-note">${ps.status === 'uploading' ? t('Pack wird hochgeladen …') : t('Pack wird eingelesen …')}</p>`;
    if (ps.error) html += '<p class="error" data-f="err"></p>';
    if (!d.pack && !d.me?.canUpload) html += `<p class="dub-note">${d.source === 'game' ? t('Das Spiel am PC wählt gerade das Pack.') : t('Warte, bis die Spielleitung ein Pack hochlädt.')}</p>`;
    box.innerHTML = html;
    const f = (n) => box.querySelector(`[data-f="${n}"]`);
    if (f('title')) f('title').textContent = d.pack.title;
    if (f('sub')) f('sub').textContent = [d.pack.authors?.length ? t(`von ${d.pack.authors.join(', ')}`) : '', t(`${d.pack.perfCount} Zeilen`)].filter(Boolean).join(' · ');
    if (f('err')) f('err').textContent = t(ps.error);
    if (f('bar')) {
      const need = D.need || 0, have = Math.min(D.files.size, need);
      const up = ps.loading;
      f('bar').style.width = need ? `${(have / need) * 100}%` : '0%';
      f('load').textContent = !D.pack ? t('Pack wird geladen …')
        : have < need ? t(`Pack wird geladen: ${have} von ${need}`)
        : up ? t(`Zeilen vom PC: ${up.have} von ${up.need}`)
        : t('Pack ist geladen.');
    }
    if (f('video')) f('video').textContent = t(`Video wird für den Browser vorbereitet: ${Math.round((video.pct || 0) * 100)} %`);
  }

  function renderPackUpload(d, box) {
    const can = !!d.me?.canUpload;
    if (same(box, JSON.stringify(['u', can, !!d.pack]))) {
      const sel = box.querySelector('[data-act="order"]');
      if (sel && document.activeElement !== sel) sel.value = d.orderMode;
      return;
    }
    if (!can) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="dub-drop" data-id="drop">
        <p class="dub-note">${d.pack ? t('Anderes Pack hochladen') : t('Lade ein Dub-Pack hoch: eine ZIP-Datei oder den Pack-Ordner (mit dub_video.ogv). Packs findest du im Spiel unter packs_voice oder machst sie mit Voicitool.')}</p>
        <div class="dub-row">
          <button type="button" class="btn btn-soft" data-act="pick-zip">${t('ZIP-Datei wählen')}</button>
          <button type="button" class="btn btn-soft" data-act="pick-dir">${t('Ordner wählen')}</button>
        </div>
        <input type="file" accept=".zip,application/zip" data-id="zip-input">
        <input type="file" webkitdirectory directory multiple data-id="dir-input">
        <p class="dub-note" data-f="up"></p>
      </div>${d.pack ? `<label class="dub-row">${t('Reihenfolge der Zeilen')}
          <select class="dub-select" data-act="order">
            <option value="chrono">${t('Wie im Video')}</option>
            <option value="file">${t('Nach Dateiname')}</option>
            <option value="character">${t('Nach Figur')}</option>
            <option value="random">${t('Zufällig')}</option>
          </select></label>` : ''}`;
    const sel = box.querySelector('[data-act="order"]');
    if (sel) sel.value = d.orderMode;
    const up = box.querySelector('[data-f="up"]');
    if (up) up.textContent = D.uploading || '';
    setupDrop($id('drop'));
  }


  function renderChars(d) {
    const card = $id('chars-card');
    if (!d.pack) { card.hidden = true; return; }
    card.hidden = false;
    if (same(card, JSON.stringify(['c', d.chrono, d.characters, d.me, S.state.players.map((p) => [p.id, p.name, p.kind]), d.players.map((p) => p.spectator), d.phase, d.leader]))) return;
    const lead = isLeader() && d.phase === 'hub';
    let html = `<div class="row-between"><h2>${d.chrono ? t('Der Reihe nach') : t('Figuren claimen')}</h2></div>`;
    html += `<p class="muted small">${d.chrono ? t('Alle Zeilen kommen nacheinander, ihr wechselt euch ab.') : t('Tipp die Figuren an, die du sprechen willst. Freie Figuren bekommt beim Start jemand zufällig. Hat eine Zeile zwei Figuren, nehmen beide getrennt auf.')}</p>`;
    if (lead) html += `<label class="dub-switch"><input type="checkbox" data-act="chrono" ${d.chrono ? 'checked' : ''}> ${t('Der Reihe nach (ohne Figuren)')}</label>`;
    html += `<label class="dub-switch"><input type="checkbox" data-act="spectate" ${d.me?.spectator ? 'checked' : ''}> ${t('Nur zuschauen')}</label>`;
    card.innerHTML = html;
    if (!d.chrono) {
      const grid = node('div', 'claim-grid');
      for (const c of d.characters) {
        const b = node('button', 'claim');
        b.type = 'button';
        const mine = c.claimedBy === S.playerId;
        const taken = c.claimedBy && !mine;
        b.className = 'claim' + (mine ? ' mine' : '') + (taken ? ' taken' : '') + (!c.claimedBy ? ' free' : '');
        b.disabled = !!taken || d.me?.spectator;
        b.setAttribute('aria-pressed', String(mine));
        const lines = c.lines === 1 ? t('1 Zeile') : t(`${c.lines} Zeilen`);
        b.append(node('strong', null, c.name), node('span', null, mine ? t(`Deine Figur, ${lines}`) : taken ? pname(c.claimedBy) : t(`${lines}, frei`)));
        b.dataset.claim = c.name;
        b.dataset.on = String(!mine);   // gewünschter Zustand: doppelt getippt bleibt es dabei
        grid.append(b);
      }
      card.append(grid);
    } else {
      const ol = node('ol', 'dub-order');
      for (const p of S.state.players.filter((x) => !d.players.find((y) => y.id === x.id)?.spectator)) {
        const li = node('li', p.id === S.playerId ? 'me' : '', p.name + (p.kind === 'local' ? ' ' + t('(am PC)') : ''));
        ol.append(li);
      }
      card.append(ol);
    }
  }

  function renderInvite(d) {
    const card = $id('invite-card');
    card.hidden = !(d.source !== 'game' && d.me?.leader);
    if (card.hidden) return;
    if (card.dataset.code === S.code) return;
    card.dataset.code = S.code;
    const url = `${location.origin}/?r=${S.code}`;
    card.innerHTML = `<h2>${t('Leute einladen')}</h2><div class="dub-invite"><img alt="${t('QR-Code zum Beitreten')}" src="/api/rooms/${S.code}/qr.png"><div><p class="dub-code"></p><p class="dub-link"></p><button type="button" class="btn btn-soft" data-act="copy">${t('Link kopieren')}</button></div></div>`;
    card.querySelector('.dub-code').textContent = S.code;
    card.querySelector('.dub-link').textContent = url;
  }

  function renderPlayers(d) {
    const card = $id('players-card');
    if (same(card, JSON.stringify(['pl', S.state.players, d.players, d.leader, !!d.pack, isLeader()]))) return;
    card.innerHTML = `<h2>${t('Mitspieler')}</h2>`;
    const ul = node('ul', 'player-list');
    for (const p of S.state.players) {
      const info = d.players.find((x) => x.id === p.id) || {};
      const li = node('li');
      li.append(node('span', null, p.name + (p.id === S.playerId ? ' ' + t('(du)') : '')));
      const tag = node('span', 'tag');
      if (p.id === d.leader) { const lt = node('span', 'dub-lead-tag', t('Leitung')); li.firstChild.append(' ', lt); }
      if (p.kind === 'local') { tag.textContent = t('am PC'); tag.className += ' ok'; }
      else if (!p.connected) { tag.textContent = t('getrennt'); tag.className += ' off'; }
      else if (info.spectator) tag.textContent = t('schaut zu');
      else if (!d.pack) tag.textContent = t('dabei');
      else if (info.ready) { tag.textContent = t('hat das Pack'); tag.className += ' ok'; }
      else if (info.progress) tag.textContent = t(`lädt ${info.progress.have}/${info.progress.need}`);
      else tag.textContent = t('prüft');
      li.append(tag);
      // Spielleitung (Raum im Browser) kann andere entfernen
      if (isLeader() && p.kind === 'phone' && p.id !== S.playerId) {
        const k = node('button', 'dub-kick', '✕');
        k.type = 'button';
        k.dataset.kick = p.id;
        k.title = t('Entfernen');
        k.setAttribute('aria-label', t('Entfernen'));
        li.append(k);
      }
      ul.append(li);
    }
    card.append(ul);
  }

  function renderStart(d) {
    const card = $id('start-card');
    const cs = d.canStart || {};
    const hasTakes = d.takes.length > 0;
    if (same(card, JSON.stringify(['s', cs, d.takes.length, d.leader, d.me, !!d.pack, d.source, S.state.players.map((p) => p.name)]))) return;
    if (!isLeader()) {
      card.innerHTML = `<p class="status-line" data-f="w"></p>`;
      card.querySelector('[data-f="w"]').textContent = !d.pack ? t('Warte auf ein Pack') :
        d.source === 'game' && !d.leader ? t('Warte auf den Start am PC') : t(`Warte, bis ${pname(d.leader)} startet`);
      return;
    }
    const reason = {
      no_pack: t('Erst ein Pack hochladen.'),
      no_lines: t('In diesem Pack gibt es keine Zeilen zum Sprechen.'),
      no_players: t('Es spielt niemand mit.'),
      video_loading: t('Das Video ist noch nicht fertig.'),
      pack_loading: t('Die erste Zeile kommt gerade vom PC.'),
      loading: t(`Noch nicht alle haben das Pack (${(cs.waiting || []).map(pname).join(', ')}).`),
    }[cs.reason] || '';
    card.innerHTML = `
      <button type="button" class="btn btn-go" data-act="start" ${cs.ok ? '' : 'disabled'}>${hasTakes ? t('Weitermachen') : t('Runde starten')}</button>
      ${cs.reason === 'loading' ? `<button type="button" class="btn btn-soft" data-act="force">${t('Trotzdem starten')}</button>` : ''}
      ${hasTakes ? `<button type="button" class="btn btn-soft" data-act="reset">${t('Neu anfangen (Aufnahmen verwerfen)')}</button>` : ''}
      <p class="dub-note" data-f="r"></p>`;
    card.querySelector('[data-f="r"]').textContent = hasTakes ? `${t(`${d.takes.length} Aufnahmen sind schon da.`)} ${reason}` : reason;
  }

  function renderChat(card, d) {
    if (!card) return;
    if (!card.dataset.built) {
      card.dataset.built = '1';
      card.innerHTML = `<h2>${t('Chat')}</h2><div class="dub-chat-log"></div><form data-act="chat"><input maxlength="200" placeholder="${t('Nachricht')}"><button class="btn btn-soft" type="submit">${t('Senden')}</button></form>`;
    }
    const log = card.querySelector('.dub-chat-log');
    const key = d.chat.length ? d.chat[d.chat.length - 1].at + ':' + d.chat.length : '0';
    if (log.dataset.key === key) return;
    log.dataset.key = key;
    log.replaceChildren(...d.chat.map((m) => {
      const p = node('p');
      p.append(node('b', null, m.name + ': '), document.createTextNode(m.text));
      return p;
    }));
    if (!d.chat.length) log.append(node('p', 'dub-note', t('Noch keine Nachrichten.')));
    log.scrollTop = log.scrollHeight;
  }

  /* ---------- Hochladen ---------- */

  function setupDrop(drop) {
    if (drop.dataset.ready) return;
    drop.dataset.ready = '1';
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const items = [...(e.dataTransfer.items || [])];
      const entry = items[0]?.webkitGetAsEntry?.();
      if (entry?.isDirectory) return uploadFiles(await readDir(entry));
      const f = e.dataTransfer.files[0];
      if (f && /\.zip$/i.test(f.name)) uploadZip(f);
      else if (e.dataTransfer.files.length > 1) uploadFiles([...e.dataTransfer.files]);
      else toast(t('Bitte eine ZIP-Datei oder einen Ordner ablegen.'));
    });
  }

  function readDir(entry) {
    return new Promise((resolve) => {
      const out = [];
      const reader = entry.createReader();
      const more = () => reader.readEntries(async (list) => {
        if (!list.length) return resolve(out);
        for (const it of list) if (it.isFile) out.push(await new Promise((r) => it.file(r, () => r(null))));
        more();
      }, () => resolve(out));
      more();
    });
  }

  function xhr(method, url, body, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded, e.total);
      x.onload = () => {
        let j = {};
        try { j = JSON.parse(x.responseText || '{}'); } catch {}
        if (x.status >= 200 && x.status < 300) resolve(j);
        else reject(new Error(j.error || `HTTP ${x.status}`));
      };
      x.onerror = () => reject(new Error(t('Verbindung zum Server unterbrochen.')));
      x.send(body);
    });
  }

  function setUp(text) {
    D.uploading = text;
    const f = $d('[data-f="up"]');
    if (f) f.textContent = text || '';
  }

  const mb = (n) => (n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1);

  async function uploadZip(file) {
    const order = dv()?.orderMode || 'chrono';
    try {
      setUp(t(`Hochladen: 0 von ${mb(file.size)} MB`));
      await xhr('PUT', auth(`/api/rooms/${S.code}/dub/pack/zip?order=${order}`), file, (a, b) => setUp(t(`Hochladen: ${mb(a)} von ${mb(b)} MB`)));
      setUp('');
    } catch (e) {
      setUp('');
      toast(t(e.message));
    }
  }

  async function uploadFiles(files) {
    files = files.filter(Boolean).filter((f) => !f.webkitRelativePath || f.webkitRelativePath.split('/').length <= 2);
    if (!files.length) return;
    const total = files.reduce((s, f) => s + f.size, 0);
    let done = 0;
    try {
      await xhr('POST', auth(`/api/rooms/${S.code}/dub/pack/begin`), null);
      for (const f of files) {
        await xhr('PUT', auth(`/api/rooms/${S.code}/dub/pack/file?name=${encodeURIComponent(f.name)}`), f,
          (a) => setUp(t(`Hochladen: ${mb(done + a)} von ${mb(total)} MB`)));
        done += f.size;
      }
      setUp(t('Pack wird eingelesen …'));
      await xhr('POST', auth(`/api/rooms/${S.code}/dub/pack/commit`), JSON.stringify({ orderMode: dv()?.orderMode || 'chrono' }));
      setUp('');
    } catch (e) {
      setUp('');
      toast(t(e.message));
    }
  }

  /* ---------- Studio ---------- */

  function renderStudio() {
    const d = dv();
    if (!d) return;
    const studio = $id('studio');
    studio.classList.toggle('expanded', D.expanded);
    $d('.dub-close-big').textContent = t('Verkleinern');
    if (d.phase === 'results') return renderResults(d);
    D.resultsFor = -1;
    renderTurn(d);
  }

  function renderTurn(d) {
    const turn = d.turn;
    const clip = currentClip();
    const key = turn ? `${turn.index}:${turn.clipId}:${D.pack ? 1 : 0}` : '';
    const me = turn?.recorders.find((r) => r.id === S.playerId);
    D.mine = !!me && !me.done && !me.skipped;
    $id('results').hidden = true;
    $id('video').hidden = true;
    $id('wave').hidden = false;
    if (key !== D.turnKey) {
      D.turnKey = key;
      newTurn(clip);
    }
    const cap = $id('caption');
    cap.hidden = false;
    cap.textContent = clip?.caption || '';
    cap.style.opacity = D.captionOn && !D.opts.noCaptions ? 1 : 0;
    renderRemote();
    renderExtra(d);
    drawWave();
  }

  async function newTurn(clip) {
    stopPlayer();
    if (D.mode === 'record') D.rec?.stop();
    D.mode = 'idle';
    D.take = null;
    D.live = null;
    D.attempts = 0;
    D.offset = 0;
    D.drawUntil = 0;
    D.playhead = null;
    D.captionOn = false;
    D.shownClipDrawn = false;
    const img = $id('img');
    img.hidden = true;
    noise(true);
    if (!clip) return;
    prioritize([clip.audio, clip.image]);
    const myKey = D.turnKey;
    await sleep(450);
    if (myKey !== D.turnKey) return;
    noise(false);
    img.src = blobUrl(clip.image);
    img.hidden = !clip.image;
    let an = null;
    try { an = await clipAnalysis(clip.audio); } catch (e) { console.warn(e); }
    if (myKey !== D.turnKey) return;
    // Wie im Spiel: der Clip läuft einmal von selbst, die Wellenform baut sich dabei auf
    if (an) {
      D.mode = 'first';
      renderRemote();
      if (D.mine) wsSend({ type: 'dub.activity', what: 'listen' });
      const buf = await getBuffer(clip.audio);
      playBuffers([{ buf, gain: D.opts.muteClip ? 0 : 1 }], () => {
        if (myKey !== D.turnKey) return;
        D.shownClipDrawn = true;
        D.drawUntil = an.duration;
        if (D.mode === 'first') D.mode = 'idle';
        D.captionOn = true;
        $id('caption').style.opacity = D.opts.noCaptions ? 0 : 1;
        renderRemote();
        drawWave();
      });
    }
  }

  function btn(act, label, enabled, extra = '') {
    return `<button type="button" class="cv-btn ${extra}" data-act="${act}" ${enabled ? '' : 'disabled'}>${label}</button>`;
  }

  function renderRemote() {
    const d = dv();
    const box = $id('remote');
    if (!box || !d || d.phase === 'results') return;
    const turn = d.turn;
    const clip = currentClip();
    const busy = D.mode === 'first' || D.mode === 'send';
    if (same(box, JSON.stringify(['r', D.mode, D.mine, D.attempts, !!D.take, D.turnKey, d.done, d.total, d.turn, d.players.map((p) => [p.id, p.activity, p.spectator]), S.state.players.map((p) => p.name), D.opts.oneTake, D.opts.quietRec, d.turns.length, clip?.id]))) return;
    let html = `<h3>${turn ? t(`Zeile ${d.done + 1} von ${d.total}`) : ''}</h3>`;
    html += `<p class="dub-speaker">${clip?.chars?.length ? SPEAKER : ''}<span data-f="chars"></span></p>`;
    if (D.mine) {
      const rec = D.mode === 'record';
      const listen = D.mode === 'listen';
      const canRec = !busy && !listen && (!D.opts.oneTake || D.attempts === 0);
      html += `<div class="dub-btns">
        ${listen ? btn('stop-listen', `<span class="sq"></span>${t('Anhören beenden')}`, true) : btn('listen', t('Clip nochmal anhören'), !busy && !rec)}
        ${rec ? btn('stop-rec', `<span class="sq"></span>${t('Aufnahme beenden')}`, true, 'rec') : btn('record', t('Aufnehmen'), canRec, 'rec')}
        ${btn('synced', D.mode === 'synced' ? `<span class="sq"></span>${t('Stopp')}` : t('Synchron anhören'), !!D.take && !busy && !rec && !listen)}
        <span class="gap"></span>
        ${btn('next', `${t('Weiter')} ▶`, !!D.take && !busy && !rec, 'wide')}
      </div>
      <button type="button" class="cv-pill dub-quiet" data-act="quiet" aria-pressed="${!!D.opts.quietRec}" ${rec ? 'disabled' : ''}
        title="${t('Beim Aufnehmen läuft die Originalstimme nicht mit, damit sie nicht ins Mikro kommt. Am Handy ist das von Anfang an so.')}">
        ${D.opts.quietRec ? t('Stimme beim Aufnehmen: aus') : t('Stimme beim Aufnehmen: an')}</button>`;
      if (D.mode === 'send') html += `<p class="dub-who">${t('Deine Aufnahme wird gesendet …')}</p>`;
    } else {
      const who = turn?.recorders || [];
      const open = who.filter((r) => !r.done && !r.skipped);
      const act = (id) => ({ listen: t('hört zu'), record: t('nimmt auf'), review: t('hört nach') })[d.players.find((p) => p.id === id)?.activity] || '';
      html += `<p class="dub-who" data-f="who"></p>`;
      html += `<div class="dub-btns">${btn('listen', t('Clip anhören'), !!clip && !busy && D.mode !== 'listen')}</div>`;
      html += `<ul class="dub-order-mini" data-f="order"></ul>`;
      box.innerHTML = html;
      const w = box.querySelector('[data-f="who"]');
      if (me(turn)?.done && open.length) w.textContent = t(`Gesendet. Warte auf ${open.map((r) => r.name).join(', ')}.`);
      else if (!open.length) w.textContent = t('Gleich geht es weiter …');
      else w.textContent = open.map((r) => `${r.name} ${act(r.id) || t('ist dran')}`).join(', ');
      const ol = box.querySelector('[data-f="order"]');
      const cur = new Set(open.map((r) => r.id));
      for (const p of S.state.players) {
        if (d.players.find((x) => x.id === p.id)?.spectator) continue;
        ol.append(node('li', cur.has(p.id) ? 'now' : '', p.name + (p.id === S.playerId ? ' ' + t('(du)') : '')));
      }
      const nx = nextMine(d);
      if (nx) ol.after(node('p', 'dub-who small', nx));
      box.querySelector('[data-f="chars"]').textContent = (clip?.chars || []).join(', ');
      renderOnscreen(d, open);
      return;
    }
    box.innerHTML = html;
    box.querySelector('[data-f="chars"]').textContent = (clip?.chars || []).join(', ');
    renderOnscreen(d, []);
  }

  const me = (turn) => turn?.recorders.find((r) => r.id === S.playerId);

  function nextMine(d) {
    const i = d.turns.findIndex((x, k) => k > d.turn.index && x.recorders.includes(S.playerId));
    if (i < 0) return '';
    const n = i - d.turn.index;
    return n === 1 ? t('Deine nächste Zeile kommt als Nächstes.') : t(`Deine nächste Zeile kommt in ${n} Zeilen.`);
  }

  function renderOnscreen(d, open) {
    const os = $id('onscreen');
    const recording = open.filter((r) => d.players.find((p) => p.id === r.id)?.activity === 'record');
    os.hidden = !recording.length || D.mine;
    if (!os.hidden) os.firstChild.textContent = '● ' + t(`${recording.map((r) => r.name).join(', ')} nimmt auf`);
  }

  function renderExtra(d) {
    const box = $id('extra');
    const lead = isLeader();
    const pause = d.pause;
    const wait = d.waitClip;
    const clipNow = d.turn?.clipId || '';
    if (same(box, JSON.stringify(['e', lead, pause && Math.ceil((pause.until - serverNow()) / 1000), wait, clipNow, D.skipSent === clipNow]))) return;
    let html = `<button type="button" class="cv-pill" data-act="options">${t('Optionen')}</button><p class="dub-status grow" data-f="st"></p>`;
    if (lead) {
      if (pause || d.turn) html += `<button type="button" class="cv-pill" data-act="skip" ${D.skipSent === clipNow ? 'disabled' : ''}>${pause ? t('Überspringen') : t('Zeile überspringen')}</button>`;
      html += `<button type="button" class="cv-pill" data-act="hub">${t('Zur Lobby')}</button>`;
    }
    box.innerHTML = html;
    const st = box.querySelector('[data-f="st"]');
    if (pause) {
      st.className = 'dub-status grow warn';
      const left = Math.max(0, Math.ceil((pause.until - serverNow()) / 1000));
      st.textContent = t(`Pausiert: ${pause.name} ist nicht verbunden. Weiter in ${left} s.`);
      clearTimeout(D.pauseTick);
      D.pauseTick = setTimeout(() => dv()?.pause && renderExtra(dv()), 1000);
    } else if (wait) {
      // Das Spiel lädt noch: die Zeile kommt gleich, dann geht es von selbst weiter
      st.className = 'dub-status grow warn';
      st.textContent = t('Die nächste Zeile kommt gerade vom PC …');
    }
  }

  /* ---------- Ergebnis ---------- */

  function tier(x) {
    if (x <= 0.1) return t('Erbärmlich!');
    if (x <= 0.2) return t('Unprofessionell!');
    if (x <= 0.4) return t('Irgendwann klappt das schon!');
    if (x <= 0.6) return t('Behalte lieber deinen Hauptjob!');
    if (x <= 0.8) return t('Talentiert!');
    if (x < 1) return t('Der nächste große Star!');
    return t('Perfektion!');
  }

  function clipScore(d, clipId) {
    if (d.gameScores && clipId in d.gameScores) return d.gameScores[clipId];
    const s = d.takes.filter((x) => x.clipId === clipId && x.score != null).map((x) => x.score);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
  }

  function renderResults(d) {
    noise(false);
    $id('img').hidden = true;
    $id('onscreen').hidden = true;
    $id('caption').textContent = '';
    $id('caption').hidden = true;
    D.take = null;
    D.live = null;
    D.mine = false;
    const watching = !!D.watch;
    const video = $id('video');
    if (D.view?.video && D.pack) {
      const src = auth(`/api/rooms/${S.code}/dub/video`) + `&v=${D.version}`;
      if (video.dataset.src !== src && ['ready', 'original'].includes(d.video.status)) {
        video.dataset.src = src;
        video.src = src;
        video.load();
      }
    }
    if (D.pack?.backing && D.backEl.dataset.src !== D.pack.backing && D.files.get(D.pack.backing)) {
      D.backEl.dataset.src = D.pack.backing;
      D.backEl.src = blobUrl(D.pack.backing);
    }
    video.hidden = !watching;
    $id('results').hidden = watching;
    $id('wave').hidden = true;
    renderResultsScreen();
    renderResultsRemote(d);
    renderResultsExtra(d);
  }

  function renderResultsScreen(force = false) {
    const d = dv();
    const box = $id('results');
    if (!box || !d || d.phase !== 'results') return;
    const sig = JSON.stringify([d.takes.map((x) => x.v), d.gameScores, D.pack?.clips.length, document.documentElement.dataset.style, document.documentElement.dataset.theme]);
    if (!force && box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const perf = (D.pack?.clips || []).filter((c) => !c.useAsIs);
    const scores = [];
    const per = {};
    const rows = [];
    for (const c of perf) {
      const s = clipScore(d, c.id);
      const takes = d.takes.filter((x) => x.clipId === c.id);
      if (s != null) {
        scores.push(s);
        for (const x of takes) (per[x.playerId] = per[x.playerId] || []).push(x.score ?? s);
      }
      rows.push({ c, s, takes });
    }
    const overall = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length / 100 : 0;
    box.innerHTML = `<h3>${t('Ergebnis')}</h3><hr><div class="dub-results-list"><p class="dub-big" data-f="big"></p><p class="dub-best" data-f="best"></p></div>`;
    box.querySelector('[data-f="big"]').textContent = `${(overall * 100).toFixed(2)} %\n${tier(overall)}`;
    let best = null;
    for (const [pid, arr] of Object.entries(per)) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      if (!best || avg > best.avg) best = { pid, avg };
    }
    if (best && Object.keys(per).length > 1) box.querySelector('[data-f="best"]').textContent = t(`${pname(best.pid)} war am genauesten, mit ${Math.round(best.avg)} %! Stark!`);
    const list = box.querySelector('.dub-results-list');
    for (const r of rows) {
      const row = node('div', 'dub-rrow');
      const img = node('img');
      img.alt = '';
      img.src = blobUrl(r.c.image);
      const txt = node('span', null, r.s == null ? t('Keine Aufnahme') : t(`Wertung: ${Math.round(r.s)} %`));
      txt.append(node('small', null, r.takes.map((x) => x.name).join(', ')));
      const cv = node('canvas');
      cv.width = 320;
      cv.height = 96;
      row.append(img, txt, cv);
      list.append(row);
      thumb(cv, r.c, r.takes);
    }
  }

  /** Kleine Wellenform im Ergebnis: Original und Aufnahme übereinander. */
  async function thumb(cv, clip, takes) {
    try {
      const an = await clipAnalysis(clip.audio);
      const g = cv.getContext('2d');
      const w = cv.width, h = cv.height, mid = h / 2;
      const draw = (data, colIn, colOut) => {
        const top = Math.max(data.top, 0.02);
        const pps = w / Math.max(0.5, an.duration + 0.05);
        for (let i = 0; i < data.avg.length; i++) {
          const x = (i / FPS) * pps;
          const a = Math.min(1, data.max[i] / top) * (h / 2 - 2);
          g.fillStyle = colOut;
          g.fillRect(x, mid - a, Math.max(1, pps / FPS + 0.5), a * 2);
          const b = Math.min(a, (data.avg[i] / top) * (h / 2) * 1.7);
          g.fillStyle = colIn;
          g.fillRect(x, mid - b, Math.max(1, pps / FPS + 0.5), b * 2);
        }
      };
      draw(an, css('--clip-in'), css('--clip-out'));
      for (const x of takes) {
        const buf = await takeBuffer(x);
        draw(waveData(buf.getChannelData(0), buf.sampleRate), css('--take-in'), css('--take-out'));
      }
    } catch {}
  }

  function renderResultsRemote(d) {
    const box = $id('remote');
    const lead = isLeader();
    const watching = !!D.watch;
    const wait = !!d.waitGame;
    if (same(box, JSON.stringify(['rr', lead, watching, D.expanded, wait]))) return;
    let html = `<h3>${t('Fertig!')}</h3><div class="dub-btns">`;
    if (lead) html += watching ? btn('watch-stop', `<span class="sq"></span>${t('Anschauen beenden')}`, true, 'wide') : btn('watch', t('Gemeinsam anschauen'), !wait, 'wide');
    else html += watching ? btn('watch-stop', `<span class="sq"></span>${t('Stopp')}`, true, 'wide') : '';
    html += watching ? '' : btn('watch-local', t('Nur hier anschauen'), true, 'wide');
    html += btn('expand', D.expanded ? t('Verkleinern') : t('Vergrößern'), true, 'wide');
    html += '</div>';
    if (wait && !watching) html += `<p class="dub-who small">${t('Das Spiel am PC spielt noch die letzten Aufnahmen ein. Gleich geht es los.')}</p>`;
    else if (!lead && !watching) html += `<p class="dub-who small">${t('Die Spielleitung startet das gemeinsame Anschauen.')}</p>`;
    box.innerHTML = html;
  }

  function renderResultsExtra(d) {
    const box = $id('extra');
    const lead = isLeader();
    const ex = d.export || {};
    if (same(box, JSON.stringify(['re', lead, ex, d.ffmpeg]))) return;
    let html = `<button type="button" class="cv-pill" data-act="options">${t('Optionen')}</button><div class="grow dub-exp" data-f="exp"></div>`;
    if (lead) html += `<button type="button" class="cv-pill" data-act="hub">${t('Zur Lobby')}</button>`;
    box.innerHTML = html;
    const exp = box.querySelector('[data-f="exp"]');
    const row = node('div', 'dub-row');
    if (!d.ffmpeg) {
      exp.append(node('p', 'dub-status', t('Auf diesem Server fehlt ffmpeg. Lade die Aufnahmen als ZIP herunter und mach das Video im Spiel oder mit Voicitool.')));
    } else if (ex.status === 'done') {
      const a = node('a', 'cv-pill dub-link-btn', t('Video herunterladen'));
      a.href = auth(`/api/rooms/${S.code}/dub/export.mp4`);
      a.setAttribute('download', ex.name || 'dub.mp4');
      row.append(a);
    } else if (ex.status === 'queued' || ex.status === 'running') {
      exp.append(node('p', 'dub-status', t(`Video wird erstellt: ${Math.round((ex.pct || 0) * 100)} %`)));
      const bar = node('div', 'dub-bar');
      const sp = node('span');
      sp.style.width = `${Math.round((ex.pct || 0) * 100)}%`;
      bar.append(sp);
      exp.append(bar);
    } else if (lead) {
      const b = node('button', 'cv-pill', t('Als Video exportieren'));
      b.type = 'button';
      b.dataset.act = 'export';
      row.append(b);
      if (ex.status === 'error') exp.append(node('p', 'dub-status warn', t(ex.error || 'Der Export ist fehlgeschlagen.')));
    } else {
      exp.append(node('p', 'dub-status', t('Die Spielleitung kann das Ergebnis als Video exportieren.')));
    }
    const z = node('a', 'cv-pill dub-link-btn', t('Aufnahmen als ZIP'));
    z.href = auth(`/api/rooms/${S.code}/dub/takes.zip`);
    z.setAttribute('download', '');
    row.append(z);
    exp.append(row);
  }

  /* ---------- Optionen ---------- */

  function openOptions() {
    const box = $id('options');
    const o = D.opts;
    const opt = (k, label, help) => `<label class="dub-opt"><input type="checkbox" data-opt="${k}" ${o[k] ? 'checked' : ''}><span>${label}<small>${help}</small></span></label>`;
    box.innerHTML = `<div class="dub-options-box" role="dialog" aria-modal="true">
      <h3>${t('Optionen')}</h3>
      ${opt('muteBacking', t('Hintergrundmusik stumm'), t('Beim Anschauen läuft die Musik des Packs nicht mit. Meist nicht empfohlen.'))}
      ${opt('oneTake', t('Nur ein Versuch'), t('Schwierigkeit: jede Zeile nur einmal aufnehmen.'))}
      ${opt('muteClip', t('Clip stumm'), t('Schwierigkeit: die Clips sind nicht zu hören, nur zu sehen.'))}
      ${opt('quietRec', t('Beim Aufnehmen stumm'), t('Beim Aufnehmen läuft die Originalstimme nicht mit, damit sie nicht ins Mikro kommt. Am Handy ist das von Anfang an so.'))}
      ${opt('noCaptions', t('Keine Untertitel'), t('Schwierigkeit: der Text der Zeile wird nicht angezeigt.'))}
      <label class="vol">${t('Clip beim Aufnehmen')}<input type="range" min="0" max="1" step="0.05" data-vol="clipVol" value="${o.clipVol}"><span>${Math.round(o.clipVol * 100)} %</span></label>
      <label class="vol">${t('Hintergrundmusik')}<input type="range" min="0" max="1" step="0.05" data-vol="backVol" value="${o.backVol}"><span>${Math.round(o.backVol * 100)} %</span></label>
      <p class="dub-note">${t('Tipp: Mit Kopfhörern klingt die Aufnahme am saubersten.')}</p>
      <button type="button" class="cv-btn" data-act="options-close">${t('Zurück')}</button>
    </div>`;
    box.hidden = false;
  }

  /* ================= Bedienung ================= */

  async function onClick(e) {
    const kick = e.target.closest('[data-kick]');
    if (kick) {
      if (confirm(t(`${pname(kick.dataset.kick)} wirklich entfernen?`))) wsSend({ type: 'dub.kick', playerId: kick.dataset.kick });
      return;
    }
    const b = e.target.closest('[data-act], [data-claim]');
    if (!b || b.disabled) return;
    if (b.dataset.claim) return wsSend({ type: 'dub.claim', character: b.dataset.claim, on: b.dataset.on === 'true' });
    const d = dv();
    const clip = currentClip();
    switch (b.dataset.act) {
      case 'pick-zip': return $id('zip-input').click();
      case 'pick-dir': return $id('dir-input').click();
      case 'copy':
        try { await navigator.clipboard.writeText(`${location.origin}/?r=${S.code}`); toast(t('Link kopiert')); } catch { toast(t('Kopieren nicht möglich')); }
        return;
      case 'start': return wsSend({ type: 'dub.start' });
      case 'force': return wsSend({ type: 'dub.start', force: true });
      case 'reset':
        if (confirm(t('Alle Aufnahmen dieser Runde verwerfen?'))) wsSend({ type: 'dub.reset' });
        return;
      case 'listen': {
        if (!clip) return;
        const buf = await getBuffer(clip.audio);
        D.mode = D.mine ? 'listen' : D.mode;
        if (D.mine) wsSend({ type: 'dub.activity', what: 'listen' });
        renderRemote();
        playBuffers([{ buf, gain: D.opts.muteClip ? 0 : 1 }], () => { if (D.mode === 'listen') D.mode = 'idle'; renderRemote(); });
        return;
      }
      case 'stop-listen':
      case 'stop-synced':
        stopPlayer();
        D.mode = 'idle';
        return renderRemote();
      case 'record': return clip && record(clip);
      case 'quiet':
        D.opts.quietRec = !D.opts.quietRec;
        saveOpts();
        return renderRemote();
      case 'stop-rec': return D.rec?.stop();
      case 'synced': {
        if (D.mode === 'synced') { stopPlayer(); D.mode = 'idle'; return renderRemote(); }
        if (!clip || !D.take) return;
        const buf = await getBuffer(clip.audio);
        const tb = S.ctx.createBuffer(1, D.take.pcm.length, D.take.rate);
        tb.copyToChannel(D.take.pcm, 0);
        D.mode = 'synced';
        renderRemote();
        playBuffers([{ buf, gain: D.opts.muteClip ? 0 : D.opts.clipVol }, { buf: tb, at: D.offset }], () => { if (D.mode === 'synced') D.mode = 'idle'; renderRemote(); });
        return;
      }
      case 'next': return clip && sendTake(clip);
      case 'skip': {
        // Nur diese Zeile überspringen, auch wenn doppelt getippt
        const clipId = d?.turn?.clipId;
        if (!clipId || D.skipSent === clipId) return;
        D.skipSent = clipId;
        wsSend({ type: 'dub.skip', clipId });
        return renderExtra(d);
      }
      case 'hub': return wsSend({ type: 'dub.hub' });
      case 'options': return openOptions();
      case 'options-close':
        $id('options').hidden = true;
        return renderStudio();
      case 'watch': return wsSend({ type: 'dub.watch' });
      case 'watch-stop':
        if (D.watchId === 'local' || !isLeader()) return stopWatch();
        return wsSend({ type: 'dub.watch.stop' });
      case 'watch-local': return startWatch(serverNow() + 400, 'local');
      case 'expand':
      case 'shrink':
        D.expanded = b.dataset.act === 'expand' && !D.expanded;
        return renderStudio();
      case 'export': return wsSend({ type: 'dub.export' });
      default:
    }
  }

  function onChange(e) {
    const x = e.target;
    if (x.dataset.id === 'zip-input' && x.files[0]) { uploadZip(x.files[0]); x.value = ''; return; }
    if (x.dataset.id === 'dir-input' && x.files.length) { uploadFiles([...x.files]); x.value = ''; return; }
    if (x.dataset.act === 'chrono') return wsSend({ type: 'dub.settings', chrono: x.checked });
    if (x.dataset.act === 'spectate') return wsSend({ type: 'dub.spectate', on: x.checked });
    if (x.dataset.act === 'order') return wsSend({ type: 'dub.settings', orderMode: x.value });
    if (x.dataset.opt) { D.opts[x.dataset.opt] = x.checked; saveOpts(); return; }
    if (x.dataset.vol) {
      D.opts[x.dataset.vol] = Number(x.value);
      x.nextElementSibling.textContent = `${Math.round(Number(x.value) * 100)} %`;
      saveOpts();
    }
  }

  function onSubmit(e) {
    const f = e.target.closest('form[data-act="chat"]');
    if (!f) return;
    e.preventDefault();
    const input = f.querySelector('input');
    const text = input.value.trim();
    if (text) wsSend({ type: 'dub.chat', text });
    input.value = '';
  }

  /* ================= Nachrichten ================= */

  function onMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        let key = null;
        try { key = localStorage.getItem('vp:key:' + S.code); } catch {}
        if (key) wsSend({ type: 'dub.open', key });
        return;
      }
      case 'dub.time': {
        const now = Date.now();
        const rtt = now - msg.t;
        if (rtt >= 0 && rtt < D.clock.rtt) {
          D.clock.rtt = rtt;
          D.clock.offset = msg.server - (msg.t + rtt / 2);
        }
        return;
      }
      case 'dub.watch':
        if (dv()?.phase === 'results' || S.state?.dub) startWatch(msg.at, msg.id);
        return;
      case 'dub.watch.stop':
        if (D.watchId !== 'local') stopWatch();
        return;
      case 'dub.hub':
        stopWatch();
        return;
      default:
    }
  }

  /* ================= Raum im Browser erstellen ================= */

  /** Karte auf der Startseite: eigener Raum zum Synchronisieren, ganz ohne Spiel. */
  function initJoin() {
    const form = document.getElementById('join-form');
    if (!form || document.getElementById('dub-create')) return;
    const card = node('div', 'glass stack join-card');
    card.id = 'dub-create';
    card.innerHTML = `<h2>${t('Selbst einen Raum erstellen')}</h2>
      <p class="muted small">${t('Synchronisieren direkt im Browser, ohne Spiel: du lädst ein Dub-Pack hoch, die anderen treten mit dem Code bei.')}</p>
      <button class="btn btn-soft" type="button">${t('Raum erstellen')}</button>`;
    form.after(card);
    card.querySelector('button').addEventListener('click', async (e) => {
      const btnEl = e.currentTarget;
      const name = document.getElementById('join-name').value.trim();
      const err = document.getElementById('join-error');
      err.hidden = true;
      if (!name) {
        err.textContent = t('Gib zuerst deinen Namen ein.');
        err.hidden = false;
        document.getElementById('join-name').focus();
        return;
      }
      btnEl.disabled = true;
      try {
        await setupAudio();
        const code = await createRoom(name, (pos) => {
          err.textContent = t(`Der Server ist gerade voll. Du bist in der Warteschlange auf Platz ${pos}. Es geht automatisch weiter.`);
          err.hidden = false;
        });
        err.hidden = true;
        S.code = code;
        S.name = name;
        S.token = null;
        try { localStorage.setItem('vp:name', name); } catch {}
        history.replaceState(null, '', `?r=${code}`);
        connect();
      } catch (ex) {
        err.textContent = t(ex.message || String(ex));
        err.hidden = false;
      } finally {
        btnEl.disabled = false;
      }
    });
  }
  initJoin();


  async function createRoom(name, onWait) {
    let ticket = '';
    for (;;) {
      const r = await fetch('/api/rooms?game=dub' + (ticket ? '&ticket=' + encodeURIComponent(ticket) : ''), { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j.queue) {
        // Server voll: der Reihe nach warten, alle paar Sekunden mit derselben Wartenummer nachfragen
        ticket = j.queue.ticket;
        onWait?.(j.queue.position);
        await new Promise((res) => setTimeout(res, 4000));
        continue;
      }
      if (!r.ok) throw new Error(j.message || t('Der Raum konnte nicht erstellt werden.'));
      try { localStorage.setItem('vp:key:' + j.code, j.hostKey); } catch {}
      return j.code;
    }
  }
})();
