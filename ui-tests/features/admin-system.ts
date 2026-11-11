/** Admin system page: fs's overview, config, fns and live output, each tab its own URL. */
import { check, count, feature, find, open, tid } from '../kit.ts';

export default feature({
  id: 'admin-system', ref: 'admin system', title: 'One system: overview, config, fns, logs',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/systems/fs', 'main');
    await ctx.shot('overview');
    await open(ctx, '/admin/systems/fs/config', tid('gin-form'));
    await ctx.shot('config');
    await open(ctx, '/admin/systems/fs/fns', tid('fns'));
    check((await page.$eval(tid('fns'), (el) => el.textContent)).includes('shell'), 'the fns tab lists fs/shell');
    await ctx.shot('fns');
    await open(ctx, '/admin/systems/fs/logs', tid('log'));
    await find(page, 'log');
    check(await count(page, 'log') === 1, 'the logs tab shows the output');
    await ctx.shot('logs');
  },
});
