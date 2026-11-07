/**
 * Attachments (chat-features 4.10): a fn that changes a file attaches a diff to the answer, drawn as a card under its
 * run by the fs system's renderer (or, without one, as its data folded behind Show all). The write is undone after,
 * so the file is gone again.
 */
import { QualifiedName } from '@harness/core';
import { Approver, clientInfo, finished, SessionWatch } from '../../scripts/session.ts';
import { check, feature, find, newChat, settle, show, tid } from '../kit.ts';

/** A scratch file under the screenshots folder, which git ignores. */
const SCRATCH = 'ui-tests/shots/attachment-check.md';

export default feature({
  id: 'attachments', ref: 'chat-features 4.10', title: 'A fn’s attachment as a card in the thread',
  async run(ctx) {
    const { page, api } = ctx;
    const session = await newChat(ctx);
    const watch = new SessionWatch(api, session);
    try {
      const approver = new Approver(api, watch);
      const { result: write } = await approver.during((async () => {
        const invoked = await api.hub.call('invoke', { session, fn: QualifiedName.parse('fs/write'), args: { path: SCRATCH, text: '# Attached\n\nA line the diff shows.\n' }, client: clientInfo() });
        await watch.next('run', (e) => e.run === invoked.run && finished(e.update), 60_000);
        return invoked;
      })());
      const card = await find(page, 'attachment', 30_000);
      const title = await card.evaluate((el) => el.textContent);
      check(title.includes('attachment-check.md'), `the attachment names the file it changed (saw "${title.slice(0, 80)}")`);
      check(await page.$(`${tid('attachment')} ${tid('renderer')}, ${tid('attachment')} .peek`) !== null, 'the attachment draws through its renderer or shows its data');
      await show(page, tid('attachment'));
      await settle(page);
      const cards = await page.$$eval(`[data-testid="run-card"][data-run="${write.run}"]`, (els) => els.length);
      check(cards === 1, `the write's run shows one card, not ${cards}`);
      const thread = await page.$eval(tid('thread'), (el) => el.textContent);
      check(!thread.includes('Someone'), 'nothing in the thread is credited to "Someone"');
      check(await page.$(`${tid('user-message')} ${tid('attachment')}`) !== null, 'the diff sits under the message that ran the write');
      await ctx.shot('attachment');
      const undone = await api.hub.call('undoTurn', { turn: write.turn });
      check(undone.undone.length > 0, 'the write is undone, so the scratch file goes');
    } finally {
      watch.stop();
    }
  },
});
