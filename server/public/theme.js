// Stil der Seite: "aero" (wie im Spiel), "dark" (schlicht, dunkel), "simple" (schlicht, hell).
// Wird im Browser gemerkt und unten über ein Aufklappmenü gewählt.
// Auf der Seite: data-style = aero | simple, data-theme = light | dark.
(function () {
  var KEY = 'vp:style';
  // Reihenfolge im Menü: erst wie im Spiel, dann dunkel, dann hell
  var STYLES = [['aero', 'Spiel-Stil'], ['dark', 'Dunkler Stil'], ['simple', 'Schlichter Stil']];
  var get = function () {
    try { var v = localStorage.getItem(KEY); return STYLES.some(function (s) { return s[0] === v; }) ? v : 'aero'; } catch (e) { return 'aero'; }
  };
  var pick = null;
  var apply = function (style) {
    var root = document.documentElement;
    root.dataset.style = style === 'aero' ? 'aero' : 'simple';
    root.dataset.theme = style === 'dark' ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = style === 'dark' ? '#14171c' : style === 'simple' ? '#f3f6f9' : '#4cc3f2';
    if (pick) pick.set(style, label('Aussehen wechseln'));
    window.dispatchEvent(new Event('stylechange'));
  };
  // Die Übersetzung steht erst bereit, wenn i18n.js geladen ist (theme.js läuft davor)
  var label = function (s) { return window.t ? window.t(s) : s; };
  apply(get());
  document.addEventListener('DOMContentLoaded', function () {
    pick = window.VG_UI.dropdown({
      title: label('Aussehen wechseln'),
      options: STYLES.map(function (s) { return [s[0], label(s[1])]; }),
      value: get(),
      onPick: function (style) {
        try { localStorage.setItem(KEY, style); } catch (e) { /* privates Fenster */ }
        apply(style);
      },
    });
    pick.el.classList.add('style-wrap');
    (document.querySelector('.page-tools') || document.getElementById('app') || document.body).appendChild(pick.el);
    apply(get());
  });
  // Sprache gewechselt: Beschriftungen im Menü nachziehen
  document.addEventListener('vg-lang', function () {
    if (!pick) return;
    var opts = pick.el.querySelectorAll('.lang-opt');
    for (var i = 0; i < opts.length; i++) opts[i].textContent = label(STYLES[i][1]);
    pick.set(get(), label('Aussehen wechseln'));
  });
})();
