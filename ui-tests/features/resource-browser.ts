/**
 * The resource browser (build 2 design 3.8): the list, the grid and the groups (by type, source, folder and date),
 * the folder tree on wide screens, a filter, opening a resource beside or over the list, and an upload, all from the
 * URL, at a desktop, a tall tablet and a phone, in light and dark.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, tid } from '../kit.ts';
import { samples } from '../resources.ts';

export default feature({
  id: 'resource-browser', ref: 'build-2 3.8', title: 'Resource browser', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page } = ctx;
    await samples(ctx.api, ctx.url('/'));
    await inEachScheme(ctx, async (shot) => {
      await open(ctx, '/resources', tid('resource-row'));
      check(await page.$$eval(tid('resource-row'), (rows) => rows.length) > 0, 'the list shows resources');
      await shot('list');

      await open(ctx, '/resources?view=grid', tid('resource-card'));
      await settle(page, 800);
      await shot('grid');
      await open(ctx, '/resources?view=grid&size=s', tid('resource-card'));
      await shot('grid-small');

      for (const group of ['type', 'source', 'path', 'date'] as const) {
        await open(ctx, `/resources?view=groups&group=${group}`, tid('resource-group'));
        await settle(page, 800);
        check(await page.$$eval(tid('resource-group'), (groups) => groups.length) > 0, `grouping by ${group} shows groups`);
        await shot(`groups-${group}`);
      }
      const first = await page.$eval(tid('resource-group'), (el) => el.getAttribute('data-group') ?? '');
      await page.click(`${tid('resource-group')} .all`);
      await page.waitForFunction(() => new URL(location.href).searchParams.has('in'));
      const narrowed = new URL(page.url()).searchParams.get('in');
      check(narrowed === first, `"Show all" narrows to the group (${first}, got ${narrowed ?? 'none'})`);
      await settle(page);
      await shot('group-all');

      await open(ctx, '/resources?q=ui-sample%20family%3Aimage', tid('resource-row'));
      const names = await page.$$eval(`${tid('resource-row')} .name`, (els) => els.map((el) => el.textContent.trim()));
      check(names.length > 0 && names.every((n) => /\.(png|svg)$/.test(n)), `the image filter shows only images (got ${names.join(', ')})`);
      await shot('filtered');

      if (ctx.viewport === 'desktop') {
        await open(ctx, '/resources', tid('folder-tree'));
        await page.click(`${tid('folder-tree')} ${tid('folder-node')}`);
        await page.waitForFunction(() => new URL(location.href).searchParams.has('under'));
        await settle(page, 600);
        await shot('folder');
      }

      await open(ctx, '/resources?q=ui-sample.md', tid('resource-row'));
      await page.click(`${tid('resource-row')} .open`);
      await page.waitForFunction(() => new URL(location.href).searchParams.has('uri'));
      await find(page, 'resource-viewer');
      await settle(page, 800);
      await shot('opened');
    });

    await open(ctx, '/resources', tid('open-uploader'));
    await page.click(tid('open-uploader'));
    const input = await page.waitForSelector(tid('file-input'));
    check(input !== null, 'the uploader has a file input');
    const name = `ui-upload-${Date.now().toString(36)}.txt`;
    await page.evaluate((fileName) => {
      const field = document.querySelector('[data-testid="file-input"]');
      if (!(field instanceof HTMLInputElement)) { return; }
      const files = new DataTransfer();
      files.items.add(new File(['uploaded from the ui tests'], fileName, { type: 'text/plain' }));
      field.files = files.files;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }, name);
    await page.waitForFunction((fileName) => [...document.querySelectorAll('.upload.done .name')].some((el) => el.textContent === fileName), { timeout: 20_000 }, name);
    await ctx.shot('uploaded');
    const uploaded = await ctx.api.hub.call('browseResources', { search: name });
    check(uploaded.items.some((r) => r.stat.name === name), 'the upload is a hub resource');
    for (const r of uploaded.items) { await ctx.api.hub.call('deleteResource', { uri: r.uri }); }
  },
});
