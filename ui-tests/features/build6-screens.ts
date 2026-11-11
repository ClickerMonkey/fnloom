/**
 * Build 6's new screens, rendered: the file explorer of an fs instance (tree in its own column, the folder's entries,
 * a file opened beside them or in their place) and a system fs hosts ("Hosted by fs/main at systems/random", with
 * restart and stop). Against the mock hub, or a real stack once fs hosts a system there.
 */
import { check, feature, find, isPhone, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'build6-screens', ref: 'build-6 design 1, 2', title: 'File explorer and hosted systems', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/explore/fs/main', tid('explore-page'));
    await find(page, 'explore-entry');
    await page.click(`${tid('explore-entry')} .open`);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="explore-entry"]').length > 1, { timeout: 10_000 });
    if (!isPhone(ctx)) { check(await page.$(tid('explore-node')) !== null, 'the folder tree shows in its own column'); }
    await settle(page);
    await ctx.shot('folder');
    const file = await page.$$eval(tid('explore-entry'), (rows) => rows.findIndex((row) => row.getAttribute('data-type') === 'file'));
    const rows = await page.$$(`${tid('explore-entry')} .open`);
    const row = rows[file];
    check(row !== undefined, 'the folder has a file');
    await row.click();
    await find(page, 'explore-file');
    await page.waitForFunction(() => (document.querySelector('[data-testid="explore-file"]')?.textContent ?? '').length > 40, { timeout: 10_000 });
    check(new URL(page.url()).searchParams.get('open') !== null, 'the opened file is in the URL');
    await settle(page);
    await ctx.shot('file');

    await open(ctx, '/admin/systems/random', tid('system-host'));
    check((await page.$eval(tid('system-host'), (el) => el.textContent)).includes('fs/main at systems/random'), 'the system says who hosts it and where');
    check(await page.$(tid('host-restart')) !== null && await page.$(tid('host-stop')) !== null, 'restart and stop are offered');
    await settle(page);
    await ctx.shot('hosted');
  },
});
