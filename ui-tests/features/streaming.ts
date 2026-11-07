/** Streaming (chat-features 2.3, 2.6, 3.1, 5.1): send a message; the answer streams into one assistant row. */
import { check, compose, count, feature, newChat, sendComposer, settle, tid } from '../kit.ts';

export default feature({
  id: 'streaming', ref: 'chat-features 2.3, 2.6, 3.1, 5.1', title: 'Send a message and watch the answer stream',
  async run(ctx) {
    const { page } = ctx;
    await newChat(ctx);
    await compose(page, 'Reply with exactly three words: hello from harness.');
    await ctx.shot('typed');
    await sendComposer(ctx);
    await page.waitForSelector(tid('user-message'), { timeout: 15_000 });
    await page.waitForSelector(`${tid('typing-indicator')}, ${tid('pending-answer')}, ${tid('assistant-answer')}`, { timeout: 60_000 });
    await ctx.shot('waiting');
    await page.waitForFunction(() => {
      const answers = document.querySelectorAll('[data-testid="answer-text"]');
      return answers.length > 0 && document.querySelector('[data-testid="session-status"]') === null;
    }, { timeout: 240_000 });
    await settle(page, 600);
    check(await count(page, 'assistant-answer') === 1, 'one turn gets one assistant answer');
    await ctx.shot('answered');
  },
});
