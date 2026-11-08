/**
 * The context inspector (build 2 design 3.4): "what would a message get?" in a chat's settings, answered by the
 * session's contextor with the selected context and fns, their weights and the window's split; and an LLM call's
 * Context tab when the hub saved what its contextor chose. The fixture chat goes back to the agent's contextor.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, show, tid } from '../kit.ts';

export default feature({
  id: 'context-graph', ref: 'build-2 3.4', title: 'Context inspector', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api, fixtures } = ctx;
    await api.hub.call('updateSession', { session: fixtures.session, contextor: { type: 'graph' } });
    try {
      await inEachScheme(ctx, async (shot) => {
        await open(ctx, `/chat/${fixtures.session}?panel=settings`, tid('preview-details'));
        await page.click(`${tid('preview-details')} summary`);
        await page.click(`${tid('preview-text')} textarea`, { count: 3 });
        await page.type(`${tid('preview-text')} textarea`, 'How many lines does README.md have?');
        await page.click(tid('preview-run'));
        await find(page, 'selection-report', 30_000);
        const parts = await page.$$eval(`${tid('budget-bar')} .segment`, (els) => els.length);
        check(parts >= 2, `the budget bar splits the window (${parts} parts)`);
        await show(page, tid('selection-report'));
        await settle(page);
        await shot('preview');
        await show(page, tid('selected-fns'));
        await shot('preview-fns');
      });

      // an LLM call of the fixture turn: its Context tab, when the hub saved the selection
      const tree = await api.hub.call('tree', { turn: fixtures.readTurn });
      const call = tree.llmCalls[0];
      if (call !== undefined && (await api.hub.call('llmCall', { id: call.id })).selection !== undefined) {
        await open(ctx, `/chat/${fixtures.session}?llm=${call.id}&callTab=context`, tid('selection-report'));
        await ctx.shot('llm-context');
      }
    } finally {
      await api.hub.call('updateSession', { session: fixtures.session, contextor: null });
    }
  },
});
