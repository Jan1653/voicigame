// Stil umschalten: "aero" (wie im Spiel) oder "simple" (schlicht). Wird im Browser gemerkt.
(function () {
  var KEY = 'vp:style';
  var get = function () { try { return localStorage.getItem(KEY) === 'simple' ? 'simple' : 'aero'; } catch (e) { return 'aero'; } };
  var apply = function (style) {
    document.documentElement.dataset.style = style;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = style === 'simple' ? '#f3f6f9' : '#4cc3f2';
    var btn = document.getElementById('style-toggle');
    if (btn) {
      btn.textContent = style === 'simple' ? 'Spiel-Stil' : 'Schlichter Stil';
      btn.setAttribute('aria-pressed', String(style === 'simple'));
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
      var next = get() === 'simple' ? 'aero' : 'simple';
      try { localStorage.setItem(KEY, next); } catch (e) {}
      apply(next);
    };
    (document.querySelector('.page-tools') || document.getElementById('app') || document.body).appendChild(btn);
    apply(get());
  });
})();
