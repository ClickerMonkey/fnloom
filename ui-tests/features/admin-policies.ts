/** Admin policies: the list, and the form for a new policy. */
import { feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'admin-policies', ref: 'admin policies', title: 'Policies',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/policies', 'main');
    await ctx.shot('list');
    await page.click(tid('new-policy'));
    await find(page, 'policy-form');
    await settle(page);
    await ctx.shot('form');
    await page.keyboard.press('Escape');
  },
});
