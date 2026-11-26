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

  // ---- defined terms: one floating layer shows the definition of the term under the pointer, in focus, or tapped,
  // above everything (sticky table headers, scrolling tables, cards). Delegated, so terms added later work too.
  var layer = document.createElement('div');
  layer.className = 'tip-layer';
  layer.setAttribute('aria-hidden', 'true'); // the term's own tooltip (aria-describedby) is what assistive tech reads
  document.body.appendChild(layer);
  var active = null;
  var pinned = null;
  function show(term) {
    var tip = term.querySelector('.tip');
    if (!tip) { return; }
    active = term;
    if (layer.dataset.for !== tip.id) { layer.innerHTML = tip.innerHTML; layer.dataset.for = tip.id; }
    layer.classList.add('on');
    layer.classList.remove('below');
    var r = term.getBoundingClientRect();
    var w = layer.offsetWidth;
    var h = layer.offsetHeight;
    var pad = 12;
    var cx = r.left + r.width / 2;
    var left = Math.max(pad, Math.min(window.innerWidth - pad - w, cx - w / 2));
    var top = r.top - h - 10;
    if (top < 64) { top = r.bottom + 10; layer.classList.add('below'); }
    layer.style.left = left + 'px';
    layer.style.top = top + 'px';
    layer.style.setProperty('--ax', Math.max(14, Math.min(w - 14, cx - left)) + 'px');
  }
  function hide() {
    if (pinned) { show(pinned); return; }
    active = null;
    layer.classList.remove('on');
  }
  var termOf = function (el) { return el && el.closest ? el.closest('.term') : null; };
  window.addEventListener('scroll', function () { if (active) { show(active); } }, { passive: true });
  window.addEventListener('resize', function () { if (active) { show(active); } });
  document.addEventListener('pointerover', function (e) { var t = termOf(e.target); if (t && e.pointerType !== 'touch') { show(t); } });
  document.addEventListener('pointerout', function (e) {
    var t = termOf(e.target);
    if (t && !t.contains(e.relatedTarget) && e.pointerType !== 'touch' && document.activeElement !== t) { hide(); }
  });
  document.addEventListener('focusin', function (e) { var t = termOf(e.target); if (t) { show(t); } });
  document.addEventListener('focusout', function (e) { if (termOf(e.target)) { hide(); } });
  document.addEventListener('click', function (e) {
    var t = termOf(e.target);
    if (!t) { if (pinned) { pinned.classList.remove('open'); pinned = null; hide(); } return; }
    if (pinned === t) { t.classList.remove('open'); pinned = null; hide(); return; }
    if (pinned) { pinned.classList.remove('open'); }
    pinned = t;
    t.classList.add('open');
    show(t);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') { return; }
    if (pinned) { pinned.classList.remove('open'); pinned = null; }
    hide();
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
