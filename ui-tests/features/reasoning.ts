/** Reasoning (chat-features 3.9): a model's reasoning sits collapsed above its answer and opens on click. */
import { check, count, feature, openSession, settle } from '../kit.ts';

const TOGGLE = '[data-testid="reasoning"] .reasoning-toggle';

export default feature({
  id: 'reasoning', ref: 'chat-features 3.9', title: 'Collapsible reasoning',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await ctx.shot('thread');
    // reasoning streams live; after a reload only answers whose reasoning the hub kept show it
    if (await count(page, 'reasoning') === 0) { return; }
    check(await page.$eval(TOGGLE, (el) => el.getAttribute('aria-expanded')) === 'false', 'reasoning starts collapsed');
    await page.click(TOGGLE);
    await settle(page);
    check(await page.$eval(TOGGLE, (el) => el.getAttribute('aria-expanded')) === 'true', 'clicking opens it');
    await ctx.shot('open');
  },
});
