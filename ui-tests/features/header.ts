/** Header bar (chat-features 1.4): the title edits in place and the change survives a reload. */
import { check, feature, find, newChat, settle, textOf, tid } from '../kit.ts';

export default feature({
  id: 'header', ref: 'chat-features 1.4', title: 'Editable title and header controls',
  async run(ctx) {
    const { page } = ctx;
    await newChat(ctx);
    await find(page, 'chat-header');
    await ctx.shot('header');
    await page.click(tid('chat-title'));
    const input = await find(page, 'title-input');
    await input.evaluate((el) => { if (el instanceof HTMLInputElement) { el.select(); } });
    await page.keyboard.type('Renamed by UI test');
    await page.keyboard.press('Enter');
    await settle(page, 600);
    await ctx.shot('renamed');
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'chat-title');
    check((await textOf(page, 'chat-title')).includes('Renamed by UI test'), 'the new title survives a reload');
  },
});
