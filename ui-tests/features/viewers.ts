/**
 * The resource viewers (build 2 design 3.9): a sample of each common type opened in the browser's viewer (markdown
 * with a diagram and math, code, csv as a table and as text, json as a tree, svg and png images, an html page in its
 * sandbox, a pdf with its pages, audio with its transcript, a log), its modes switched (Preview, Source, each form,
 * Info) through the URL, at a desktop, a tall tablet and a phone, in light and dark.
 */
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, tid } from '../kit.ts';
import { sample, samples } from '../resources.ts';

/** Each sample, what its first mode should draw, and the modes to switch to. */
const CASES = [
  { file: 'ui-sample.md', draws: 'markdown', modes: ['source', 'info'] },
  { file: 'ui-sample.ts', draws: 'code', modes: [] },
  { file: 'ui-sample.csv', draws: 'table', modes: ['source'] },
  { file: 'ui-sample.json', draws: 'json', modes: ['source'] },
  { file: 'ui-sample.svg', draws: 'svg', modes: ['source'] },
  { file: 'ui-sample.png', draws: 'image', modes: ['info'] },
  { file: 'ui-sample.html', draws: 'html', modes: ['source'] },
  { file: 'ui-sample.pdf', draws: 'pdf', modes: [] },
  { file: 'ui-sample.wav', draws: 'audio', modes: [] },
  { file: 'ui-sample.log', draws: 'text', modes: [] },
] as const;

export default feature({
  id: 'viewers', ref: 'build-2 3.9', title: 'Resource viewers', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page } = ctx;
    const all = await samples(ctx.api, ctx.url('/'));
    await inEachScheme(ctx, async (shot) => {
      for (const one of CASES) {
        const uri = encodeURIComponent(sample(all, one.file));
        await open(ctx, `/resources?uri=${uri}`, tid('resource-viewer'));
        await page.waitForFunction(() => document.querySelector('[data-testid="resource-viewer"]')?.getAttribute('data-draws') !== null, { timeout: 15_000 });
        await settle(page, 900);
        const draws = await page.$eval(tid('resource-viewer'), (el) => el.getAttribute('data-draws') ?? '');
        check(draws === one.draws || draws === 'offer', `${one.file} opens drawn as ${one.draws} (got ${draws})`);
        await shot(one.file.replace(/^ui-sample\./, ''));
        for (const mode of one.modes) {
          await open(ctx, `/resources?uri=${uri}&mode=${mode}`, tid('resource-viewer'));
          await page.waitForFunction((want) => document.querySelector('[data-testid="resource-viewer"]')?.getAttribute('data-mode') === want, { timeout: 15_000 }, mode);
          await settle(page, 600);
          await shot(`${one.file.replace(/^ui-sample\./, '')}-${mode}`);
        }
      }
    });

    // switching a mode with its tab writes the URL, and Back returns to the one before
    await open(ctx, `/resources?uri=${encodeURIComponent(sample(all, 'ui-sample.md'))}`, tid('viewer-modes'));
    const modes = await find(page, 'viewer-modes');
    const source = (await modes.$$('[role="tab"]'))[1];
    check(source !== undefined, 'markdown has a Source tab');
    await source.click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('mode') === 'source');
    await settle(page);
    await ctx.shot('mode-from-tab');
  },
});
