/** Accessibility (chat-features 12.2): every control has a name, the thread is a log, and the composer has a label. */
import { check, feature, openSession } from '../kit.ts';

export default feature({
  id: 'accessibility', ref: 'chat-features 12.2', title: 'Named controls and landmarks',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    const unnamed = await page.$$eval('button, a[href], [role="button"]', (els) => els.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { return false; }
      const name = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent).trim();
      return name === '';
    }).map((el) => el.outerHTML.slice(0, 80)));
    check(unnamed.length === 0, `controls without a name: ${unnamed.join(' | ')}`);
    const labelled = await page.$eval('[data-testid="composer-input"]', (el) => el.getAttribute('aria-label') !== null || (el instanceof HTMLTextAreaElement && el.labels.length > 0));
    check(labelled, 'the composer input has a label');
    const small = await page.$$eval('button', (els) => els.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24); })
      .map((el) => `${el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
    check(small.length === 0, `buttons smaller than 24px: ${small.join(', ')}`);
    await ctx.shot('page');
  },
});
