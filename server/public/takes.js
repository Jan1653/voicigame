/* Eigene Aufnahmen auf dem Gerät behalten und wieder anhören.
   Alles bleibt im Browser (IndexedDB), nichts davon geht an den Server: der hat die Aufnahmen
   der laufenden Runde ohnehin und löscht sie mit dem Raum.
   Warum IndexedDB: dort passen ganze Tondateien hinein, und mit „dauerhaftem Speicher“ räumt
   der Browser sie nicht bei Platzmangel von selbst weg. Löschen geht jederzeit von Hand.
   Der Platz ist begrenzt (MAX_MB, MAX_COUNT): ist er voll, fallen die ältesten heraus.

   VG_TAKES.save({room, mode, pack, clip, caption, seconds}, blob)
   VG_TAKES.open()      Übersicht anzeigen
   VG_TAKES.count()     wie viele gespeichert sind (für den Knopf unten)                        */
(function () {
  const DB = 'voicigame';
  const STORE = 'takes';
  const MAX_MB = 300;
  const MAX_COUNT = 400;
  const tr = (s) => (window.t ? window.t(s) : s);

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('at', 'at');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }

  function tx(mode, fn) {
    return db().then((d) => new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }

  const list = () => tx('readonly', (s) => s.getAll()).then((r) => (r || []).sort((a, b) => b.at - a.at));
  const remove = (id) => tx('readwrite', (s) => s.delete(id));
  const clear = () => tx('readwrite', (s) => s.clear());

  /** Zu viel geworden: die ältesten fallen heraus (list() gibt die neuesten zuerst). */
  async function prune() {
    const all = await list();
    let bytes = all.reduce((n, x) => n + (x.blob?.size || 0), 0);
    let left = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
      if (bytes <= MAX_MB * 1024 * 1024 && left <= MAX_COUNT) break;
      bytes -= all[i].blob?.size || 0;
      left--;
      await remove(all[i].id);
    }
  }

  let asked = false;
  async function save(meta, blob) {
    if (!blob || !window.indexedDB) return;
    try {
      // Einmal um dauerhaften Speicher bitten, damit der Browser nicht selbst aufräumt
      if (!asked) {
        asked = true;
        try { await navigator.storage?.persist?.(); } catch (e) { /* nicht überall da */ }
      }
      await tx('readwrite', (s) => s.add({ at: Date.now(), ...meta, blob }));
      await prune();
      document.dispatchEvent(new Event('vg-takes'));
    } catch (e) {
      console.warn('Aufnahme nicht gespeichert:', e);
    }
  }

  async function count() {
    try { return await tx('readonly', (s) => s.count()); } catch { return 0; }
  }

  /* ---------- Übersicht ---------- */

  const two = (n) => String(n).padStart(2, '0');
  const when = (ms) => {
    const d = new Date(ms);
    return `${two(d.getDate())}.${two(d.getMonth() + 1)}. ${two(d.getHours())}:${two(d.getMinutes())}`;
  };
  const size = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  let sheet = null;
  let urls = [];
  function closeSheet() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    sheet?.remove();
    sheet = null;
  }

  async function open() {
    closeSheet();
    sheet = el('div', 'sheet');
    const box = el('div', 'sheet-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    sheet.append(box);
    document.body.append(sheet);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key !== 'Escape') return;
      document.removeEventListener('keydown', esc);
      closeSheet();
    });
    await fill(box);
  }

  async function fill(box) {
    box.textContent = '';
    box.append(el('h2', null, tr('Deine Aufnahmen')));
    let items = [];
    try { items = await list(); } catch (e) { /* kein Speicher im privaten Fenster */ }
    if (!items.length) {
      box.append(el('p', 'muted', tr('Hier sammeln sich deine Aufnahmen. Noch ist nichts da.')));
    } else {
      const bytes = items.reduce((n, x) => n + (x.blob?.size || 0), 0);
      box.append(el('p', 'muted', tr(`Zusammen ${size(bytes)}. Sie liegen nur auf diesem Gerät.`)));
      const ul = el('ul', 'take-list');
      for (const it of items) ul.append(row(it, box));
      box.append(ul);
    }
    const tools = el('div', 'sheet-tools');
    if (items.length) {
      const del = el('button', 'btn', tr('Alle löschen'));
      del.type = 'button';
      del.onclick = async () => {
        if (!confirm(tr('Wirklich alle Aufnahmen auf diesem Gerät löschen?'))) return;
        await clear();
        document.dispatchEvent(new Event('vg-takes'));
        await fill(box);
      };
      tools.append(del);
    }
    const close = el('button', 'btn btn-soft', tr('Zurück'));
    close.type = 'button';
    close.onclick = closeSheet;
    tools.append(close);
    box.append(tools);
  }

  function row(it, box) {
    const li = el('li');
    const head = el('div', 'take-head');
    head.append(el('strong', null, it.caption || it.clip || tr('Aufnahme')));
    const what = [it.pack || (it.mode === 'show' ? tr('Gameshow') : tr('Dub')), it.room, when(it.at),
      it.seconds ? `${it.seconds.toFixed(1)} s` : '', size(it.blob?.size || 0)].filter(Boolean).join(' · ');
    head.append(el('span', 'muted', what));
    li.append(head);
    const url = URL.createObjectURL(it.blob);
    urls.push(url);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = url;
    li.append(audio);
    const btns = el('div', 'take-btns');
    const dl = el('a', 'btn btn-soft', tr('Speichern'));
    dl.href = url;
    dl.download = `${[it.pack, it.clip || it.mode, when(it.at).replace(/[.: ]/g, '-')].filter(Boolean).join('_')}.wav`;
    btns.append(dl);
    const del = el('button', 'btn btn-soft', tr('Löschen'));
    del.type = 'button';
    del.onclick = async () => {
      await remove(it.id);
      document.dispatchEvent(new Event('vg-takes'));
      await fill(box);
    };
    btns.append(del);
    li.append(btns);
    return li;
  }

  /* ---------- Knopf unten, sobald es etwas zu sehen gibt ---------- */

  document.addEventListener('DOMContentLoaded', async () => {
    const b = el('button', 'page-pill', tr('Deine Aufnahmen'));
    b.type = 'button';
    b.hidden = true;
    b.onclick = open;
    (document.querySelector('.page-tools') || document.body).append(b);
    const show = async () => { b.hidden = !(await count()); b.textContent = tr('Deine Aufnahmen'); };
    document.addEventListener('vg-takes', show);
    document.addEventListener('vg-lang', show);
    await show();
  });

  window.VG_TAKES = { save, open, count };
})();
