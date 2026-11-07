/** Markdown (chat-features 3.2): answers render as formatted text, not raw markdown. */
import { check, feature, find, openSession } from '../kit.ts';

export default feature({
  id: 'markdown', ref: 'chat-features 3.2', title: 'Answers render markdown',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    await find(page, 'answer-text');
    const raw = await page.$$eval('[data-testid="answer-text"]', (els) => els.some((el) => /\*\*|^#{1,6} |```/m.test(el.textContent)));
    check(!raw, 'no raw markdown markers in rendered answers');
    const formatted = await page.$$eval('[data-testid="answer-text"] p, [data-testid="answer-text"] li, [data-testid="answer-text"] code', (els) => els.length);
    check(formatted > 0, 'answers are drawn as paragraphs, lists or code');
    await ctx.shot('answer');
  },
});
