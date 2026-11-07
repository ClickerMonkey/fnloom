/**
 * Run cards (chat-features 4.1, 4.2, 4.5, 4.10): each tool run the agent made shows as a card with its status, time
 * and cost, and an answer with several runs folds them all to their one-line summaries at once.
 * (A card's live states while it runs are in `live-runs`.)
 */
import { check, count, feature, find, openSession, settle, show, tid } from '../kit.ts';

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
    const answer = `${tid('assistant-answer')}[data-turn="${ctx.fixtures.readTurn}"]`;
    await show(page, `${answer} ${tid('run-card')}`);
    await ctx.shot('cards');

    // fold every run of the agent's answer to its summary line, then open them again
    const toggle = `${answer} .collapse-all`;
    if (await page.$(toggle) !== null) {
      const cards = `${answer} [data-testid="run-card"]`;
      if (await page.$eval(toggle, (el) => el.textContent.includes('Expand'))) { await page.click(toggle); await settle(page); }
      await page.click(toggle);
      await settle(page);
      const folded = await page.$$eval(cards, (els) => els.map((el) => el.classList.contains('collapsed') && el.querySelector('.body') === null));
      check(folded.length >= 1 && folded.every(Boolean), 'Collapse all folds every run to its summary line');
      const summaries = await page.$$eval(`${cards} .summary`, (els) => els.map((el) => el.textContent.trim()));
      check(summaries.every((s) => s.length > 0), 'each folded card still says what it ran');
      await show(page, answer);
      await ctx.shot('collapsed');
      await page.click(toggle);
      await settle(page);
    }
  },
});
