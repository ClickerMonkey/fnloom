/** Admin resources: what the hub knows from fs (the repository's files), searched from the URL, and one opened. */
import { check, feature, open, settle } from '../kit.ts';

export default feature({
  id: 'admin-resources', ref: 'admin resources', title: 'Resources browser',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/resources', '.browser-row');
    await ctx.shot('list');
    await open(ctx, '/admin/resources?q=README', '.browser-row');
    check((await page.$eval('main', (el) => el.textContent)).includes('README.md'), 'searching README finds README.md');
    await ctx.shot('search');
    await page.click('.browser-row button.open');
    await page.waitForFunction(() => new URL(location.href).searchParams.has('uri'));
    await settle(page, 600);
    await ctx.shot('opened');
  },
});
