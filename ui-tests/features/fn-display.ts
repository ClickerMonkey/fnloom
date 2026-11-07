/**
 * A fn's display (chat-features 4.10): once done, a run keeps its card, becomes a line of text, or goes, as its fn
 * declares. The hub's bookkeeping fns (loading fns or context, a run's status, waiting on a run) don't leave cards
 * under the answer; searches read as a line.
 */
import { check, feature, openSession, settle, show, tid } from '../kit.ts';

/** The hub fns whose finished runs never show as cards. */
const HIDDEN = ['hub/load_fns', 'hub/drop_fns', 'hub/load_context', 'hub/run_status', 'hub/run_wait'];
/** The hub fns whose finished runs read as a line. */
const LINES = ['hub/search_fns', 'hub/search_context'];

export default feature({
  id: 'fn-display', ref: 'chat-features 4.10', title: 'Finished runs show as their fn declares',
  async run(ctx) {
    const { page, fixtures, api } = ctx;
    await openSession(ctx);
    const cards = await page.$$eval('[data-testid="run-card"]', (els) => els.map((el) => ({ fn: el.getAttribute('data-fn') ?? '', status: el.getAttribute('data-status') ?? '' })));
    const stray = cards.filter((card) => card.status === 'done' && (HIDDEN.includes(card.fn) || LINES.includes(card.fn)));
    check(stray.length === 0, `no finished hub bookkeeping run shows as a card (saw ${stray.map((c) => c.fn).join(', ')})`);
    const tree = await api.hub.call('tree', { turn: fixtures.readTurn });
    const fns = JSON.stringify(tree);
    const searched = LINES.some((fn) => fns.includes(fn));
    if (searched) {
      check((await page.$$(tid('run-message'))).length > 0, 'a search the agent ran reads as a line under the answer');
      await show(page, tid('run-message'));
    }
    check((await page.$$('[data-testid="run-card"][data-fn="fs/bash"]')).length > 0, 'a fs run keeps its card');
    await settle(page);
    await ctx.shot('thread');
  },
});
