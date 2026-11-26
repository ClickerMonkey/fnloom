// The page's small behaviours: theme toggle, reveal on scroll, the hero's pointer tilt, the story tabs, and the
// comparison's column chips. The page reads fine without any of it.
(function () {
  'use strict';
  var root = document.documentElement;
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };

  // ---- theme: system preference until the toggle pins one
  var toggle = document.querySelector('[data-theme-toggle]');
  var media = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function current() { return root.dataset.theme || (media && media.matches ? 'dark' : 'light'); }
  function label() { if (toggle) { toggle.setAttribute('aria-label', current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); } }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      store.set('theme', next);
      label();
    });
    if (media && media.addEventListener) { media.addEventListener('change', label); }
    label();
  }

  // ---- header shadow once scrolled
  var top = document.querySelector('[data-top]');
  if (top) {
    var onScroll = function () { top.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---- reveal on scroll
  var reveals = document.querySelectorAll('[data-reveal]');
  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  }

  // ---- the hero's devices lean toward the pointer (fine pointers only)
  var tilt = document.querySelector('[data-tilt]');
  if (tilt && !reduced && window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var frame = 0;
    window.addEventListener('pointermove', function (e) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(function () {
        var x = e.clientX / window.innerWidth - 0.5;
        var y = e.clientY / window.innerHeight - 0.5;
        tilt.style.setProperty('--ry', (x * 8).toFixed(2) + 'deg');
        tilt.style.setProperty('--rx', (-y * 5).toFixed(2) + 'deg');
      });
    });
  }

  // ---- story tabs (arrow keys move between them)
  document.querySelectorAll('[data-tabs]').forEach(function (box) {
    var tabs = Array.prototype.slice.call(box.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) { tab.focus(); }
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { select(tab, false); });
      tab.addEventListener('keydown', function (e) {
        var n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -2;
        if (n === -2) { return; }
        e.preventDefault();
        select(tabs[(n + tabs.length) % tabs.length], true);
      });
    });
  });

  // ---- defined terms: keep each tip on screen; tap opens one on touch screens; Escape closes
  var terms = Array.prototype.slice.call(document.querySelectorAll('.term'));
  function place(term) {
    var tip = term.querySelector('.tip');
    if (!tip) { return; }
    tip.style.setProperty('--dx', '0px');
    tip.classList.remove('below');
    var r = tip.getBoundingClientRect();
    var pad = 12;
    var dx = r.left < pad ? pad - r.left : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0;
    tip.style.setProperty('--dx', dx + 'px');
    if (r.top < 70) { tip.classList.add('below'); }
  }
  function closeAll(except) { terms.forEach(function (t) { if (t !== except) { t.classList.remove('open'); } }); }
  terms.forEach(function (term) {
    term.addEventListener('pointerenter', function () { place(term); });
    term.addEventListener('focus', function () { place(term); });
    term.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !term.classList.contains('open');
      closeAll(term);
      term.classList.toggle('open', open);
      if (open) { place(term); }
    });
  });
  document.addEventListener('click', function () { closeAll(null); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeAll(null); if (document.activeElement && document.activeElement.classList.contains('term')) { document.activeElement.blur(); } }
  });

  // ---- comparison: show or hide competitor columns
  var table = document.getElementById('matrix-table');
  var boxes = document.querySelectorAll('[data-toggle]');
  if (table && boxes.length) {
    var saved = (store.get('hidden-cols') || '').split(',').filter(Boolean);
    var apply = function () {
      var hidden = [];
      boxes.forEach(function (box) {
        var key = box.getAttribute('data-toggle');
        if (!box.checked) { hidden.push(key); }
        table.querySelectorAll('[data-col="' + key + '"]').forEach(function (cell) { cell.hidden = !box.checked; });
      });
      table.querySelectorAll('.cat th').forEach(function (th) { th.colSpan = boxes.length - hidden.length + 2; });
      store.set('hidden-cols', hidden.join(','));
    };
    boxes.forEach(function (box) {
      if (saved.indexOf(box.getAttribute('data-toggle')) !== -1) { box.checked = false; }
      box.addEventListener('change', apply);
    });
    apply();
  }
})();
