/** Shortcuts (chat-features 12.1): `?` outside a field opens the list of keyboard shortcuts. */
import { feature, find, isTouch, openSession, settle } from '../kit.ts';

export default feature({
  id: 'shortcuts', ref: 'chat-features 12.1', title: 'Keyboard shortcuts',
  async run(ctx) {
    const { page } = ctx;
    if (isTouch(ctx)) { return; } // no keyboard on a phone
    await openSession(ctx);
    await page.click('main');
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) { document.activeElement.blur(); } });
    await page.keyboard.type('?');
    await find(page, 'shortcuts');
    await settle(page);
    await ctx.shot('shortcuts');
    await page.keyboard.press('Escape');
  },
});
