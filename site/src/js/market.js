// The marketplace preview: search, category chips, and a listing's sheet (opened by #s/<id>, so links can share it).
// The listings are rendered at build time; without this script they're all simply shown.
(function () {
  'use strict';
  var dataEl = document.getElementById('m-data');
  if (!dataEl) { return; }
  var data = JSON.parse(dataEl.textContent);
  var byId = {};
  data.systems.forEach(function (s) { byId[s.id] = s; });
  var cards = Array.prototype.slice.call(document.querySelectorAll('.m-card'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.m-chip'));
  var q = document.getElementById('m-q');
  var count = document.getElementById('m-count');
  var empty = document.getElementById('m-empty');
  var cat = '';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function filter() {
    var words = (q.value || '').toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    cards.forEach(function (card) {
      var hay = card.dataset.q;
      var ok = (!cat || (' ' + card.dataset.cat + ' ').indexOf(' ' + cat + ' ') !== -1) &&
        words.every(function (w) { return hay.indexOf(w) !== -1; });
      card.hidden = !ok;
      if (ok) { shown++; }
    });
    count.textContent = shown === cards.length ? cards.length + ' systems' : shown + ' of ' + cards.length + ' systems';
    empty.hidden = shown !== 0;
  }
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      cat = chip.dataset.cat;
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      filter();
    });
  });
  q.addEventListener('input', filter);
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
  });
  filter();

  // ---- the listing sheet
  var detail = document.getElementById('m-detail');
  var body = document.getElementById('d-body');
  var sheet = detail.querySelector('.m-sheet');
  var opener = null;
  var badgeText = data.badges;
  function open(s) {
    var fns = (s.fns || []).map(function (f) {
      return '<li><span class="mode ' + f.mode + '">' + (f.mode === 'write' ? 'changes' : 'reads') + '</span>' + esc(f.label) +
        (f.asks ? '<span class="asks">asks first</span>' : '') + '</li>';
    }).join('');
    var needs = (s.needs && s.needs.length) ? '<ul class="d-needs">' + s.needs.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '<p class="d-sum">Nothing: it works as soon as it’s approved.</p>';
    body.innerHTML =
      '<div class="d-head"><span class="m-icon" style="--hue:' + s.hue + '" aria-hidden="true">' + esc(s.glyph) + '</span><div><h2 id="d-title">' + esc(s.title) + '</h2>' +
      '<p>' + esc(s.publisher) + ' · version ' + esc(s.version) + (s.example ? ' · <span class="ex">example</span>' : '') + '</p></div></div>' +
      '<p class="d-sum">' + esc(s.summary) + '</p>' +
      '<p class="m-meta">' + s.badges.map(function (b) { return '<span class="badge b-' + b + '">' + esc(badgeText[b]) + '</span>'; }).join('') + '</p>' +
      '<div class="d-sec"><h3>What it can do</h3><ul class="d-fns">' + fns + '</ul></div>' +
      '<div class="d-sec"><h3>What it needs from you</h3>' + needs + '</div>' +
      '<p class="d-install"><a class="btn" aria-disabled="true" role="link">' + (s.badges.indexOf('builtin') !== -1 ? 'Comes with your hub' : 'Install on my hub') + '</a>' +
      '<small>A preview: installing from the marketplace is coming. Today, systems install from your hub’s Admin page or by asking in chat.</small></p>';
    detail.hidden = false;
    document.body.style.overflow = 'hidden';
    sheet.focus();
  }
  function close() {
    detail.hidden = true;
    document.body.style.overflow = '';
    if (location.hash.indexOf('#s/') === 0) { history.replaceState(null, '', location.pathname + location.search); }
    if (opener) { opener.focus(); opener = null; }
  }
  function route() {
    var m = location.hash.match(/^#s\/([\w-]+)$/);
    if (m && byId[m[1]]) { open(byId[m[1]]); } else if (!detail.hidden) { close(); }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#s/"]');
    if (a) { opener = a; }
    if (e.target.closest && e.target.closest('[data-close]')) { close(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !detail.hidden) { close(); } });
  window.addEventListener('hashchange', route);
  route();
})();
