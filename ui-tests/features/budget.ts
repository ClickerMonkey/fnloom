/** Cost and budget (chat-features 9.1, 9.2): the session's cost shows live, and a session budget shows its meter. */
import { check, feature, find, openSession, settle, textOf, tid } from '../kit.ts';

export default feature({
  id: 'budget', ref: 'chat-features 9.1, 9.2', title: 'Cost and budget meters',
  async run(ctx) {
    const { page, api, fixtures } = ctx;
    await api.hub.call('setBudget', { target: { scope: 'session', session: fixtures.session }, period: 'all-time', maxCost: 2, onLimit: 'refuse' });
    await openSession(ctx);
    check((await textOf(page, 'session-cost')).includes('$'), 'the session cost shows in dollars');
    await find(page, 'budget-meter');
    await ctx.shot('meter');
    await page.click(tid('budget-meter'));
    await find(page, 'budget-details');
    await settle(page);
    await ctx.shot('details');
    await page.keyboard.press('Escape');
  },
});
