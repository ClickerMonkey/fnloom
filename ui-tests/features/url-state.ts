/** Every view tied to the URL (chat-features 1.2): a run drawer and a deep-linked message survive a reload. */
import { check, feature, find, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'url-state', ref: 'chat-features 1.2', title: 'Refresh returns to the same place',
  async run(ctx) {
    const { page, fixtures } = ctx;
    await openSession(ctx);
    await page.goto(ctx.url(`/chat/${fixtures.session}?run=${fixtures.bashRun}`), { waitUntil: 'networkidle0' });
    await find(page, 'run-details');
    await ctx.shot('run-open');
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'run-details');
    check(new URL(page.url()).searchParams.get('run') === fixtures.bashRun, 'the run stays in the URL after a reload');
    await ctx.shot('after-reload');
    await page.click(tid('panel-close'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('run'));
    await page.goto(ctx.url(`/chat/${fixtures.session}#m-${fixtures.answer}`), { waitUntil: 'networkidle0' });
    await find(page, 'thread');
    await settle(page, 800);
    const inView = await page.$eval(`[id="m-${fixtures.answer}"]`, (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; }).catch(() => false);
    check(inView, 'a #m- link scrolls its message into view');
    await ctx.shot('deep-link');
  },
});
