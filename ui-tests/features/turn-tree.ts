/** The fn tree (chat-features 4.7): a turn's runs as a tree, with the LLM calls under the agent, at its own URL. */
import { check, count, feature, find, settle, tid } from '../kit.ts';
import { open } from '../kit.ts';

export default feature({
  id: 'turn-tree', ref: 'chat-features 4.7', title: 'The fn tree of a turn',
  async run(ctx) {
    const { page, fixtures } = ctx;
    await open(ctx, `/chat/${fixtures.session}/turn/${fixtures.readTurn}/tree`, tid('turn-tree'));
    await find(page, 'tree-node');
    await settle(page);
    check(await count(page, 'tree-node') >= 2, 'the tree shows the agent and the runs it made');
    check(await count(page, 'tree-llm') >= 1, 'the agent node lists its LLM calls');
    await ctx.shot('tree');
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'turn-tree');
    check(page.url().endsWith('/tree'), 'the tree keeps its URL across a reload');
  },
});
