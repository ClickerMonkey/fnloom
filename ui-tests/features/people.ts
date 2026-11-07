/** People (chat-features 8.3): who is in the chat, and who will answer the next message. */
import { check, feature, find, isPhone, openSession, textOf } from '../kit.ts';

export default feature({
  id: 'people', ref: 'chat-features 8.3', title: 'Participants and who will answer',
  async run(ctx) {
    const { page } = ctx;
    await openSession(ctx);
    if (!isPhone(ctx)) { await find(page, 'participants'); }
    check((await textOf(page, 'answerers')).toLowerCase().includes('agent'), 'the composer says the chat agent will answer');
    await ctx.shot('people');
  },
});
