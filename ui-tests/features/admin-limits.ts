/** Admin limits: budgets with what they have spent, priority rules, and the limits a person would get. */
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'admin-limits', ref: 'admin limits', title: 'Budgets, priorities and resolved limits',
  async run(ctx) {
    const { page, api } = ctx;
    await api.hub.call('setBudget', { target: { scope: 'hub' }, period: { window: 86_400_000 }, maxCost: 10, onLimit: 'refuse' });
    await open(ctx, '/admin/limits', 'main');
    check((await page.$eval('main', (el) => el.textContent)).includes('$'), 'budgets show their amounts');
    await ctx.shot('budgets');
    await open(ctx, '/admin/limits/priorities', 'main');
    await ctx.shot('priorities');
    const me = await api.hub.call('me');
    await open(ctx, `/admin/limits/resolved?user=${me.id}`, tid('resolve-form'));
    await page.waitForSelector(`${tid('resolve')}:not([disabled])`, { timeout: 10_000 });
    await page.click(tid('resolve'));
    await find(page, 'resolved');
    await settle(page);
    await ctx.shot('resolved');
  },
});
