/** Resources from the admin area: the link leads to the resource browser, searched from the URL, and one opened. */
import { check, feature, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'admin-resources', ref: 'admin resources', title: 'Resources browser',
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/admin/resources', tid('resource-row'));
    check(new URL(page.url()).pathname === '/resources', 'the admin link leads to the resource browser');
    await ctx.shot('list');
    await open(ctx, '/resources?q=README', tid('resource-row'));
    check((await page.$eval('main', (el) => el.textContent)).includes('README.md'), 'searching README finds README.md');
    await ctx.shot('search');
    await page.click(`${tid('resource-row')} .open`);
    await page.waitForFunction(() => new URL(location.href).searchParams.has('uri'));
    await settle(page, 600);
    await ctx.shot('opened');
  },
});
