/**
 * Fleets and packages (build 2 design 3.12, 3.14): a system's Instances tab lists each attached copy (`fs@laptop`)
 * with its status and the default marked; one instance's page shows its details, its own config, and its data (the
 * folders the hub gives it and an export of its data folder); the install dialog takes a package zip.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'instances', ref: 'build-2 3.14', title: 'Instances and packages', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    const system = (await api.hub.call('systems', {})).find((s) => s.instances.length > 0);
    check(system !== undefined, 'a system has an instance');
    const first = system.instances[0];
    check(first !== undefined, 'the system lists its instances');

    await inEachScheme(ctx, async (shot) => {
      await open(ctx, `/admin/systems/${system.name}/instances`, tid('instances'));
      check(await page.$$eval(`${tid('instances')} [data-instance]`, (rows) => rows.length) === system.instances.length, 'every instance is listed');
      await shot('list');
      await open(ctx, `/admin/systems/${system.name}/instances/${first.instance}`, tid('instance-overview'));
      await shot('instance');
      await open(ctx, `/admin/systems/${system.name}/instances/${first.instance}/config`, 'main');
      await shot('config');
      await open(ctx, `/admin/systems/${system.name}/instances/${first.instance}/data`, tid('instance-data'));
      await shot('data');
    });

    // the row opens the instance's page
    await open(ctx, `/admin/systems/${system.name}/instances`, tid('instances'));
    await page.click(`${tid('instances')} ${tid('instance-row')}`);
    await find(page, 'instance-overview');

    // an export is a zip to download
    await open(ctx, `/admin/systems/${system.name}/instances/${first.instance}/data`, tid('export-data'));
    await page.click(tid('export-data'));
    await page.waitForFunction(() => document.querySelector('[data-testid="export-download"]') !== null || document.querySelector('[role="alert"]') !== null, { timeout: 20_000 });
    await settle(page);
    await ctx.shot('exported');

    // the install dialog takes a package zip
    await open(ctx, `/admin/systems/${system.name}/instances`, tid('add-instance'));
    await page.click(tid('add-instance'));
    await find(page, 'package-zone');
    await settle(page);
    await ctx.shot('install-zip');
    await page.keyboard.press('Escape');
  },
});
