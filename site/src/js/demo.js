// Drawn demos: scripted replays of the real app, written as plain HTML that already shows the finished state.
// Nothing here is needed to read the page; without JavaScript, or with reduced motion, every demo shows its end.
//
//   <div data-demo>                         a demo (the hero's devices are one demo: their beats play together)
//     <button data-goto="2">Approve</button>  a step button: replays from beat 2 and stops looping
//     <p data-beat="0" data-type>…</p>     appears at beat 0, typed out letter by letter
//     <p data-beat="1" data-wait="1200">  appears 1.2 s after the beat before it
//     <p data-beat="1" data-until="3">    shown from beat 1 until beat 3 starts (a "thinking…" line)
//     <b data-beat="4" data-press>        a button that gets pressed at beat 4
//     <x data-count="12.4" data-beat="5"> a number that counts up when it appears
//   </div>
//
// Demos play only while on screen, and loop after a pause unless someone picked a step.
(function () {
  'use strict';
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var demos = document.querySelectorAll('[data-demo]');

  function Demo(root) {
    this.root = root;
    this.beats = Array.prototype.slice.call(root.querySelectorAll('[data-beat]'));
    this.max = this.beats.reduce(function (m, el) { return Math.max(m, +el.dataset.beat); }, 0);
    this.steps = Array.prototype.slice.call(root.querySelectorAll('[data-goto]'));
    this.texts = new Map();
    var self = this;
    this.beats.forEach(function (el) { if (el.hasAttribute('data-type')) { self.texts.set(el, el.textContent); } });
    this.at = -1;
    this.timer = 0;
    this.visible = false;
    this.manual = false;
    this.steps.forEach(function (b) {
      b.addEventListener('click', function () { self.manual = true; self.jump(+b.dataset.goto); });
    });
  }
  Demo.prototype.els = function (n) { return this.beats.filter(function (el) { return +el.dataset.beat === n; }); };
  Demo.prototype.mark = function (n) {
    // the step button whose beat is the latest one at or before n
    var current = null;
    this.steps.forEach(function (b) { if (+b.dataset.goto <= n) { current = b; } });
    this.steps.forEach(function (b) { b.setAttribute('aria-pressed', String(b === current)); });
    this.root.style.setProperty('--beat', n);
    this.root.dataset.at = n;
  };
  /** Shows everything up to and including beat n at once (no typing, no counting). */
  Demo.prototype.set = function (n) {
    var self = this;
    this.beats.forEach(function (el) {
      var b = +el.dataset.beat;
      var until = el.dataset.until === undefined ? Infinity : +el.dataset.until;
      var on = b <= n && n < until;
      el.classList.toggle('on', on);
      el.classList.toggle('pre', !on);
      el.classList.toggle('pressed', el.hasAttribute('data-press') && b <= n);
      if (self.texts.has(el)) { el.textContent = self.texts.get(el); }
      if (el.dataset.count !== undefined) { el.textContent = el.dataset.count; }
    });
    // anything shown "until" a beat that has started is hidden again
    this.at = n;
    this.mark(n);
  };
  Demo.prototype.reset = function () {
    this.beats.forEach(function (el) { el.classList.remove('on', 'pressed'); el.classList.add('pre'); });
    this.at = -1;
    this.mark(-1);
  };
  Demo.prototype.stop = function () { clearTimeout(this.timer); this.timer = 0; };
  Demo.prototype.jump = function (n) {
    this.stop();
    this.set(n - 1);
    this.play();
  };
  Demo.prototype.play = function () {
    if (this.timer || !this.visible) { return; }
    var self = this;
    var next = this.at + 1;
    if (next > this.max) {
      if (this.manual) { return; }
      this.timer = setTimeout(function () {
        self.timer = 0;
        self.root.classList.add('fading');
        setTimeout(function () { self.root.classList.remove('fading'); self.reset(); self.play(); }, 450);
      }, +(this.root.dataset.hold || 4200));
      return;
    }
    var els = this.els(next);
    var wait = els.reduce(function (m, el) { return Math.max(m, +(el.dataset.wait || 0)); }, 0) || +(this.root.dataset.pace || 850);
    this.timer = setTimeout(function () {
      self.timer = 0;
      self.show(next, function () { self.play(); });
    }, next === 0 ? 400 : wait);
  };
  Demo.prototype.show = function (n, done) {
    var self = this;
    this.at = n;
    this.mark(n);
    this.beats.forEach(function (el) {
      if (el.dataset.until !== undefined && +el.dataset.until <= n) { el.classList.remove('on'); el.classList.add('pre'); }
    });
    var els = this.els(n);
    var typing = [];
    els.forEach(function (el) {
      el.classList.remove('pre');
      el.classList.add('on');
      if (el.hasAttribute('data-press')) { el.classList.add('pressed'); }
      if (self.texts.has(el)) { typing.push(el); el.textContent = ''; }
      if (el.dataset.count !== undefined) { self.count(el); }
    });
    if (!typing.length) { done(); return; }
    // all copies of a typed line type together (the hero's three devices)
    var full = typing.map(function (el) { return self.texts.get(el); });
    var len = Math.max.apply(null, full.map(function (t) { return t.length; }));
    var i = 0;
    var speed = +(this.root.dataset.typing || 26);
    var tick = function () {
      if (!self.visible) { self.timer = 0; typing.forEach(function (el, k) { el.textContent = full[k]; }); done(); return; }
      i += 1 + (Math.random() < .25 ? 1 : 0);
      typing.forEach(function (el, k) { el.textContent = full[k].slice(0, i); });
      if (i >= len) { self.timer = 0; done(); return; }
      self.timer = setTimeout(tick, speed + Math.random() * speed);
    };
    this.timer = setTimeout(tick, speed);
  };
  Demo.prototype.count = function (el) {
    var target = parseFloat(el.dataset.count);
    var places = (el.dataset.count.split('.')[1] || '').length;
    var prefix = el.dataset.prefix || '';
    var start = performance.now();
    var step = function (t) {
      var k = Math.min(1, (t - start) / 900);
      var v = target * (1 - Math.pow(1 - k, 3));
      el.textContent = prefix + v.toFixed(places);
      if (k < 1) { requestAnimationFrame(step); }
    };
    requestAnimationFrame(step);
  };

  var all = [];
  demos.forEach(function (root) {
    var d = new Demo(root);
    all.push(d);
    if (reduced || !('IntersectionObserver' in window)) { d.set(d.max); root.classList.add('still'); return; }
    d.reset();
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        d.visible = e.isIntersecting;
        if (d.visible) { d.play(); } else { d.stop(); }
      });
    }, { threshold: 0.35 }).observe(root);
  });

  // pause everything while the tab is hidden
  document.addEventListener('visibilitychange', function () {
    all.forEach(function (d) { if (document.hidden) { d.stop(); } else if (d.visible) { d.play(); } });
  });
})();
