/** Message actions (chat-features 3.3, 3.4, 3.13): an answer's action bar shows on hover (always on touch), and copy copies. */
import { check, feature, find, isPhone, openSession, point } from '../kit.ts';

const BAR = '[data-testid="assistant-answer"] [data-testid="msg-actions"]';

export default feature({
  id: 'message-actions', ref: 'chat-features 3.3, 3.4, 3.13', title: 'Hover actions: copy, link, details',
  async run(ctx) {
    const { page } = ctx;
    const origin = new URL(ctx.url('/')).origin;
    await page.browserContext().setPermission(origin, { permission: { name: 'clipboard-read' }, state: 'granted' }, { permission: { name: 'clipboard-write' }, state: 'granted' });
    await openSession(ctx);
    await find(page, 'assistant-answer');
    if (!isPhone(ctx)) { await point(ctx, '[data-testid="assistant-answer"]'); }
    await page.waitForSelector(BAR, { visible: true });
    const actions = await page.$$eval(`${BAR} [data-action]`, (els) => els.map((el) => el.getAttribute('data-action')));
    check(['copy', 'details', 'link'].every((a) => actions.includes(a)), `the answer offers copy, details and link (has ${actions.join(', ')})`);
    await ctx.shot('actions');
    await page.click(`${BAR} [data-action="copy"]`);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check(copied.length > 20, 'copy puts the answer on the clipboard');
  },
});
