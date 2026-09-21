// Stil umschalten, reihum: "aero" (wie im Spiel), "simple" (schlicht, hell), "dark" (schlicht, dunkel).
// Wird im Browser gemerkt. Auf der Seite: data-style = aero | simple, data-theme = light | dark.
(function () {
  var KEY = 'vp:style';
  var ORDER = ['aero', 'simple', 'dark'];
  var NEXT_LABEL = { aero: 'Schlichter Stil', simple: 'Dunkler Stil', dark: 'Spiel-Stil' };   // Knopf zeigt, wohin er wechselt
  var get = function () {
    try { var v = localStorage.getItem(KEY); return ORDER.indexOf(v) >= 0 ? v : 'aero'; } catch (e) { return 'aero'; }
  };
  var apply = function (style) {
    var root = document.documentElement;
    root.dataset.style = style === 'aero' ? 'aero' : 'simple';
    root.dataset.theme = style === 'dark' ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = style === 'dark' ? '#14171c' : style === 'simple' ? '#f3f6f9' : '#4cc3f2';
    var btn = document.getElementById('style-toggle');
    if (btn) {
      btn.textContent = NEXT_LABEL[style];
      btn.setAttribute('aria-pressed', String(style !== 'aero'));
    }
    window.dispatchEvent(new Event('stylechange'));
  };
  apply(get());
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.createElement('button');
    btn.id = 'style-toggle';
    btn.type = 'button';
    btn.className = 'style-toggle';
    btn.title = 'Aussehen wechseln';
    btn.onclick = function () {
      var next = ORDER[(ORDER.indexOf(get()) + 1) % ORDER.length];
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    };
    (document.querySelector('.page-tools') || document.getElementById('app') || document.body).appendChild(btn);
    apply(get());
  });
})();
