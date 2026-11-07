/** Admin actor settings: the settings systems declare (fs's shell setting) and the values people and groups have. */
import { check, feature, open } from '../kit.ts';

export default feature({
  id: 'admin-actor-settings', ref: 'admin actor settings', title: 'Declared settings and their values',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/actor-settings', 'main');
    check((await page.$eval('main', (el) => el.textContent)).toLowerCase().includes('shell'), "fs's shell setting is listed");
    await ctx.shot('settings');
  },
});
