/* Aufklappmenü, wie es unten für Sprache und Stil benutzt wird.
   Knopf mit Pfeil, Liste klappt nach oben auf, Auswahl mit Maus oder Tastatur,
   ein Klick daneben oder Escape schließt sie wieder.

   VG_UI.dropdown({ title, options: [[wert, Beschriftung], …], value, onPick })
     -> { el, set(wert, title) }                                                   */
(function () {
  function dropdown({ title = '', options = [], value = null, onPick = () => {} }) {
    const wrap = document.createElement('div');
    wrap.className = 'lang-wrap';
    wrap.setAttribute('data-nolang', '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-pick';
    btn.title = title;
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span></span><svg viewBox="0 0 12 8" aria-hidden="true"><path d="M1.5 1.5l4.5 4.5 4.5-4.5" fill="none" '
      + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const list = document.createElement('div');
    list.className = 'lang-menu';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    for (const [code, label] of options) {
      const o = document.createElement('button');
      o.type = 'button';
      o.className = 'lang-opt';
      o.setAttribute('role', 'option');
      o.dataset.code = code;
      o.textContent = label;
      list.appendChild(o);
    }
    const set = (v, newTitle) => {
      if (newTitle) btn.title = newTitle;
      btn.firstChild.textContent = (options.find((x) => x[0] === v) || [v, v])[1];
      for (const o of list.children) o.setAttribute('aria-selected', String(o.dataset.code === v));
    };
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    const onKey = (e) => {
      const items = [...list.children];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { close(); btn.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
      }
    };
    function close() {
      list.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    }
    btn.addEventListener('click', () => {
      if (!list.hidden) return close();
      list.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const cur = list.querySelector('[aria-selected="true"]') || list.firstChild;
      cur.scrollIntoView({ block: 'center' });
      cur.focus({ preventScroll: true });
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
    });
    list.addEventListener('click', (e) => {
      const o = e.target.closest('.lang-opt');
      if (!o) return;
      close();
      btn.focus();
      onPick(o.dataset.code);
    });
    set(value);
    wrap.append(btn, list);
    return { el: wrap, set };
  }

  window.VG_UI = { dropdown };
})();
