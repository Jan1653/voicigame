// „Als App installieren“: Android, Chrome und Edge über das Angebot des Browsers. Am iPhone und iPad geht das nur
// in Safari über „Teilen“ und „Zum Home-Bildschirm“, dafür zeigt der Knopf eine kurze Anleitung.
// Als App geöffnet, verschwindet der Knopf. Der Service Worker (sw.js) ist Voraussetzung fürs Installieren.
(function () {
  const tr = (s) => (window.t ? window.t(s) : s);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let offer = null;   // Angebot des Browsers (beforeinstallprompt)
  let btn = null;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function show() {
    if (btn) { btn.hidden = false; return; }
    btn = el('button', 'page-pill', tr('Als App installieren'));
    btn.type = 'button';
    btn.onclick = async () => {
      if (ios) return guide();   // Safari bietet keine Installation an, nur „Teilen“ → „Zum Home-Bildschirm“
      if (offer) {
        offer.prompt();
        const r = await offer.userChoice.catch(() => null);
        offer = null;
        if (r?.outcome === 'accepted') btn.hidden = true;
      }
    };
    (document.querySelector('.page-tools') || document.body).append(btn);
  }

  /** iPhone: So kommt die Seite auf den Home-Bildschirm. */
  function guide() {
    const sheet = el('div', 'sheet');
    const box = el('div', 'sheet-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.append(el('h2', null, tr('Als App installieren')));
    const steps = el('ol', 'install-steps');
    steps.append(el('li', null, tr('Öffne diese Seite in Safari.')));
    const share = el('li', null, tr('Tippe unten auf „Teilen“') + ' ');
    const icon = el('span', 'install-share');
    icon.setAttribute('aria-hidden', 'true');
    // Symbol wie in Safari: Kasten mit Pfeil nach oben
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M7 10H5v11h14V10h-2"/></svg>';
    share.append(icon);
    steps.append(share);
    steps.append(el('li', null, tr('Wähle „Zum Home-Bildschirm“ und tippe auf „Hinzufügen“.')));
    box.append(steps);
    box.append(el('p', 'muted', tr('Danach startest du Voicigame wie eine App, ohne Adressleiste.')));
    const tools = el('div', 'sheet-tools');
    const close = el('button', 'btn btn-soft', tr('Zurück'));
    close.type = 'button';
    close.onclick = () => sheet.remove();
    tools.append(close);
    box.append(tools);
    sheet.append(box);
    sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
    document.body.append(sheet);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();   // eigener Knopf statt des Hinweises vom Browser
    offer = e;
    show();
  });
  window.addEventListener('appinstalled', () => { if (btn) btn.hidden = true; });
  if (ios) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
    else show();
  }
  document.addEventListener('vg-lang', () => { if (btn) btn.textContent = tr('Als App installieren'); });
})();
