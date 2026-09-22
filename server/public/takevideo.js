/* Aus einer Dub-Aufnahme ein kleines Video machen: der Ausschnitt des Pack-Videos, zu dem die
   Zeile gehört, mit der eigenen Stimme darüber. Damit ist in „Deine Aufnahmen“ nicht nur der
   Ton, sondern auch das Bild dabei.

   Gerendert wird in Echtzeit im Browser: das Video läuft stumm auf ein Canvas, die Aufnahme
   läuft parallel als Ton, und beides zusammen nimmt der MediaRecorder auf. Kann der Browser
   das nicht (oder gibt es keinen Zeitpunkt im Video), kommt null zurück und es bleibt beim Ton.

   VG_TAKEVIDEO.render({url, from, seconds, pcm, rate}) -> Blob oder null                     */
(function () {
  const TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const WIDTH = 640;
  const FPS = 25;

  function pickType() {
    if (!window.MediaRecorder) return null;
    return TYPES.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || null;
  }

  const once = (el, ev, ms) => new Promise((res, rej) => {
    const t = setTimeout(() => { el.removeEventListener(ev, ok); rej(new Error(ev + ' dauert zu lange')); }, ms);
    const ok = () => { clearTimeout(t); el.removeEventListener(ev, ok); res(); };
    el.addEventListener(ev, ok, { once: true });
  });

  async function render({ url, from = 0, seconds = 0, pcm, rate }) {
    const type = pickType();
    const canvas = document.createElement('canvas');
    if (!type || !canvas.captureStream || !(seconds > 0) || !pcm?.length) return null;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(video);
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
    let rec = null;
    try {
      await once(video, 'loadedmetadata', 15000);
      const end = Math.min(video.duration || from + seconds, from + seconds);
      video.currentTime = Math.max(0, Math.min(from, Math.max(0, (video.duration || 0) - 0.05)));
      await once(video, 'seeked', 15000);

      const w = Math.min(WIDTH, video.videoWidth || WIDTH);
      canvas.width = Math.max(2, Math.round(w / 2) * 2);
      canvas.height = Math.max(2, Math.round((canvas.width * (video.videoHeight || 360)) / (video.videoWidth || 640) / 2) * 2);
      const g = canvas.getContext('2d');
      g.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Bild vom Canvas, Ton aus der Aufnahme
      const stream = canvas.captureStream(FPS);
      const dest = ctx.createMediaStreamDestination();
      const buf = ctx.createBuffer(1, pcm.length, rate);
      buf.copyToChannel(pcm instanceof Float32Array ? pcm : Float32Array.from(pcm), 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

      const parts = [];
      rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1200000, audioBitsPerSecond: 96000 });
      rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
      const stopped = new Promise((res) => (rec.onstop = res));
      rec.start();
      src.start();
      await video.play();

      // Bild für Bild nachziehen, bis das Ende der Zeile erreicht ist
      await new Promise((res) => {
        const limit = setTimeout(res, (seconds + 8) * 1000);
        const step = () => {
          g.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (video.currentTime >= end || video.ended || rec.state !== 'recording') {
            clearTimeout(limit);
            return res();
          }
          if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
          else requestAnimationFrame(step);
        };
        step();
      });
      video.pause();
      try { src.stop(); } catch (e) { /* war schon aus */ }
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      for (const tr of stream.getTracks()) tr.stop();
      return parts.length ? new Blob(parts, { type: parts[0].type || type }) : null;
    } catch (e) {
      console.warn('Video zur Aufnahme:', e.message || e);
      try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (x) { /* egal */ }
      return null;
    } finally {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      ctx.close().catch(() => {});
    }
  }

  window.VG_TAKEVIDEO = { render, can: () => !!pickType() };
})();
