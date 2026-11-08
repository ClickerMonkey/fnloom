/** Undo (chat-features 6.2): undo the last turn from the header; a note reports what was undone or had no undo. */
import { QualifiedName } from '@harness/core';
import { clientInfo } from '../../scripts/session.ts';
import { check, feature, find, hasListColumn, newChat, settle, tid } from '../kit.ts';

export default feature({
  id: 'undo', ref: 'chat-features 6.2', title: 'Undo the last turn',
  async run(ctx) {
    const { page, api } = ctx;
    const session = await newChat(ctx);
    await api.hub.call('invoke', { session, fn: QualifiedName.parse('fs/bash'), args: { command: 'echo to-undo' }, client: clientInfo() });
    await page.waitForSelector('[data-testid="run-card"][data-status="done"]', { timeout: 60_000 });
    await settle(page);
    await ctx.shot('before');
    if (!hasListColumn(ctx)) {
      // on a phone the header keeps undo in its overflow menu
      await page.click(tid('chat-menu'));
      await page.waitForSelector('[role="menuitem"]', { visible: true });
      await settle(page);
      await ctx.shot('menu');
      const items = await page.$$('[role="menuitem"]');
      const labels = await Promise.all(items.map((item) => item.evaluate((n) => n.textContent.toLowerCase())));
      const at = labels.findIndex((label) => label.includes('undo'));
      check(at >= 0, `the menu offers undo (has ${labels.join(', ')})`);
      await items[at]?.click();
    } else {
      await page.waitForSelector(`${tid('undo-last')}:not([disabled])`, { timeout: 10_000 });
      await page.click(tid('undo-last'));
    }
    await find(page, 'note', 20_000);
    await settle(page, 600);
    check((await page.$eval(tid('note'), (el) => el.textContent)).includes('fs/bash'), 'the note names the run it reports on');
    await ctx.shot('undone');
  },
});
