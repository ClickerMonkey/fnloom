/** Session settings (chat-features 9.5, 9.6): the agent, the systems the chat uses, and its priority. */
import { feature, find, hasListColumn, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'session-settings', ref: 'chat-features 9.5, 9.6', title: 'Session settings',
  also: ['wide'],
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    if (!hasListColumn(ctx)) {
      await page.click(tid('chat-menu'));
      await settle(page);
      const items = await page.$$('[role="menuitem"]');
      for (const item of items) { if ((await item.evaluate((n) => n.textContent)).toLowerCase().includes('settings')) { await item.click(); break; } }
    } else {
      await page.click(tid('open-settings'));
    }
    await find(page, 'session-settings');
    await settle(page);
    await ctx.shot('settings');
    await page.keyboard.press('Escape');
  },
});
