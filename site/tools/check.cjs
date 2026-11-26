// Renders the built site (site/dist: the home page and the marketplace) in Chromium with Playwright and checks it:
// no console errors, no sideways scroll at phone width, every local file, image and #anchor resolves. Full-page shots
// use reduced motion (every demo at its end); "motion-*" shots catch the hero and each story mid-play.
//
//   node site/tools/build.mjs && node site/tools/check.cjs    (needs `playwright` resolvable, e.g. NODE_PATH)
const { chromium } = require('playwright');
const { existsSync, mkdirSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const site = resolve(__dirname, '..');
const dist = join(site, 'dist');
const out = join(site, 'preview');
mkdirSync(out, { recursive: true });

const PAGES = [{ id: 'home', file: 'index.html' }, { id: 'market', file: join('marketplace', 'index.html') }];
const RUNS = [
  { name: 'desktop-1440-light', viewport: { width: 1440, height: 900 }, scale: 1, scheme: 'light' },
  { name: 'desktop-1440-dark', viewport: { width: 1440, height: 900 }, scale: 1, scheme: 'dark' },
  { name: 'phone-390-light', viewport: { width: 390, height: 844 }, scale: 2, scheme: 'light', mobile: true },
  { name: 'phone-390-dark', viewport: { width: 390, height: 844 }, scale: 2, scheme: 'dark', mobile: true },
  { name: 'phone-375-light', viewport: { width: 375, height: 812 }, scale: 1, scheme: 'light', mobile: true, noShot: true },
];

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  for (const pg of PAGES) {
    for (const run of RUNS) {
      const file = join(dist, pg.file);
      const base = dirname(file);
      const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: run.viewport, deviceScaleFactor: run.scale, colorScheme: run.scheme, isMobile: !!run.mobile, hasTouch: !!run.mobile });
      const tab = await ctx.newPage();
      const tag = `${pg.id} ${run.name}`;
      tab.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { problems.push(`${tag}: console ${m.type()}: ${m.text()}`); } });
      tab.on('pageerror', (e) => problems.push(`${tag}: page error: ${e.message}`));
      tab.on('requestfailed', (r) => problems.push(`${tag}: request failed: ${r.url()}`));
      await tab.goto(pathToFileURL(file).href, { waitUntil: 'load' });
      await tab.evaluate(async () => {
        document.documentElement.style.scrollBehavior = 'auto';
        for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
        window.scrollTo(0, 0);
      });
      const report = await tab.evaluate(() => {
        const doc = document.documentElement;
        const wide = [...document.querySelectorAll('body *')].filter((el) => {
          if (el.closest('.table-scroll, .t-tabs, .marquee')) { return false; }
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1);
        }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
        const anchors = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href'))
          .filter((h) => h.length > 1 && !h.startsWith('#s/') && !document.getElementById(h.slice(1)));
        const broken = [...document.images].filter((img) => img.naturalWidth === 0).map((img) => img.getAttribute('src'));
        const local = [...document.querySelectorAll('a[href]:not([href^="#"]):not([href^="http"]), link[href], script[src]')].map((el) => el.getAttribute('href') || el.getAttribute('src'));
        const tokens = document.documentElement.outerHTML.match(/\{\{\w+\}\}/g) || [];
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide, anchors, broken, local, tokens };
      });
      if (report.scrollWidth > report.clientWidth) { problems.push(`${tag}: page scrolls sideways (${report.scrollWidth} > ${report.clientWidth}): ${report.wide.join(', ')}`); }
      for (const a of report.anchors) { problems.push(`${tag}: missing anchor ${a}`); }
      for (const b of report.broken) { problems.push(`${tag}: image did not load: ${b}`); }
      for (const t of report.tokens) { problems.push(`${tag}: unfilled token ${t}`); }
      for (const l of report.local) {
        const p = join(base, l.split(/[?#]/)[0]);
        if (!existsSync(p) && !existsSync(join(p, 'index.html'))) { problems.push(`${tag}: missing file ${l}`); }
      }
      if (!run.noShot) {
        const shot = join(out, `${pg.id}-${run.name}.png`);
        await tab.screenshot({ path: shot, fullPage: true });
        console.log('shot', shot);
      }
      await ctx.close();
    }
  }

  // motion on: the hero part-way through, then each story after a few beats
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const tab = await ctx.newPage();
  tab.on('pageerror', (e) => problems.push(`motion: page error: ${e.message}`));
  await tab.goto(pathToFileURL(join(dist, 'index.html')).href, { waitUntil: 'load' });
  for (const [i, wait] of [2500, 4000, 4000].entries()) {
    await tab.waitForTimeout(wait);
    await tab.locator('.devices').screenshot({ path: join(out, `motion-hero-${i + 1}.png`) });
  }
  const tabs = await tab.$$('[role="tab"]');
  for (let i = 0; i < tabs.length; i++) {
    await tabs[i].click();
    await tab.locator('#watch .theatre').scrollIntoViewIfNeeded();
    await tab.waitForTimeout(7500);
    await tab.locator('#watch .theatre').screenshot({ path: join(out, `motion-story-${i + 1}.png`) });
  }
  await ctx.close();

  await browser.close();
  const unique = [...new Set(problems)];
  console.log(unique.length === 0 ? 'check: no problems' : `check: ${unique.length} problem(s)\n  ${unique.join('\n  ')}`);
  process.exitCode = unique.length === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(1); });
