/** Run cards (chat-features 4.1, 4.2, 4.5, 4.10): each tool run the agent made shows as a card with its status, time and cost. */
import { check, count, feature, find, openSession } from '../kit.ts';

export default feature({
  id: 'run-cards', ref: 'chat-features 4.1, 4.2, 4.5, 4.10', title: 'A run card per tool call',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await find(page, 'run-card');
    check(await count(page, 'run-card') >= 2, 'the agent turn and the hand-run command each show run cards');
    const statuses = await page.$$eval('[data-testid="run-card"]', (els) => els.map((el) => el.getAttribute('data-status')));
    check(statuses.every((s) => s === 'done'), `every fixture run is done (saw ${statuses.join(', ')})`);
    const read = await page.$$eval('[data-testid="run-card"]', (els) => els.some((el) => el.textContent.includes('Read')));
    check(read, 'the fs/read run has a card');
    await ctx.shot('cards');
  },
});
