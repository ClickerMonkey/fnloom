/**
 * People (chat-features 8.3): who is in the chat, and who will answer the next message. The header's participants
 * button (on a phone, the chat menu) opens the people panel, which lists the owner and the agent on its own (not the
 * whole settings sheet) and in view without scrolling.
 */
import { check, feature, find, isPhone, onScreen, openSession, settle, textOf, tid, visible } from '../kit.ts';

export default feature({
  id: 'people', ref: 'chat-features 8.3', title: 'Participants and who will answer',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    check((await textOf(page, 'answerers')).toLowerCase().includes('agent'), 'the composer says the chat agent will answer');
    if (isPhone(ctx)) {
      await page.click(tid('chat-menu'));
      const item = await page.waitForSelector('[role="menuitem"] ::-p-text(People)', { timeout: 10_000 });
      check(item !== null, 'the chat menu offers People');
      await item.click();
    } else {
      await page.click(tid('participants'));
    }
    await page.waitForFunction(() => new URLSearchParams(location.search).get('panel') === 'people', { timeout: 10_000 });
    const list = await find(page, 'people');
    const names = await list.evaluate((el) => el.textContent.toLowerCase());
    check(names.includes('agent'), 'the people list includes the chat agent');
    check(await list.evaluate((el) => el.querySelectorAll('li').length) >= 2, 'the people list has the owner and the agent');
    await settle(page);
    check(!(await visible(page, 'session-settings')), 'the people panel shows people, not the chat settings');
    check(await onScreen(page, 'people'), 'the people list is in view without scrolling');
    await ctx.shot('people');
  },
});
