/**
 * Security review screens (docs/plans/security-review-2026-11-21.md): the admin settings the fixes added, the
 * outside-image placeholder, and a web read in the guarded headless browser listing what it fetched. The runner also
 * checks, on every feature's shots, that the hub's CSP refused nothing.
 */
import { QualifiedName } from '@harness/core';
import { clientInfo } from '../../scripts/session.ts';
import { check, feature, find, open, settle, tid } from '../kit.ts';

export default feature({
  id: 'security', ref: 'security review 2026-11-21', title: 'Security settings and outside images',
  viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;

    // Settings › Hub: outside images ask first by default
    await open(ctx, '/settings/hub', tid('outside-images-card'));
    const on = await page.$eval(`${tid('outside-images-switch')} input`, (el) => el instanceof HTMLInputElement && el.checked).catch(() => undefined);
    check(on !== true, 'outside images wait for a click by default');
    await (await find(page, 'outside-images-card')).scrollIntoView();
    await ctx.shot('hub-outside-images');

    // People › Sign-in: password tries and proxy trust
    await open(ctx, '/admin/people/sign-in', tid('sign-in-limits'));
    await (await find(page, 'sign-in-limits')).scrollIntoView();
    await ctx.shot('sign-in-limits');
    await (await find(page, 'proxy-trust')).scrollIntoView();
    await ctx.shot('proxy-trust');

    // API services: the list (and a service's settings when one exists)
    await open(ctx, '/admin/api-services', 'main');
    await ctx.shot('api-services');

    // An outside image in an answer (people's own messages are plain text) is a placeholder until clicked
    if (!ctx.mock) {
      const session = await ctx.api.hub.call('createSession', { title: 'Security: outside image' });
      const text = 'Reply with exactly this markdown and nothing else, no tools: ![a test chart](https://example.com/chart.png)';
      await ctx.api.hub.call('send', { session: session.id, parts: [{ type: 'text', text }], client: clientInfo() });
      await open(ctx, `/chat/${session.id}`, 'main');
      await find(page, 'md-image-held', 120_000);
      const loaded = await page.$$eval('img.md-image', (imgs) => imgs.filter((img) => img instanceof HTMLImageElement && img.src.includes('example.com')).length);
      check(loaded === 0, 'the outside image did not load before the click');
      await ctx.shot('image-held');
      await page.click(tid('md-image-held'));
      await settle(page, 600);
      const shown = await page.$$eval('img.md-image', (imgs) => imgs.filter((img) => img instanceof HTMLImageElement && img.src.includes('example.com')).length);
      check(shown > 0, 'clicking the placeholder loads the image');
      await ctx.shot('image-released');
    }

    // web/read renders a page in the guarded headless browser, and its card lists every URL it fetched
    const web = ctx.mock ? [] : (await ctx.api.hub.call('systems', {})).filter((system) => system.name === 'web' && system.status === 'connected');
    if (web.length > 0) {
      const session = await ctx.api.hub.call('createSession', { title: 'Security: web read' });
      const invoked = await ctx.api.hub.call('invoke', { session: session.id, fn: QualifiedName.parse('web/read'), args: { url: 'https://example.com', render: 'always' }, client: clientInfo() });
      const deadline = Date.now() + 120_000;
      let run = await ctx.api.hub.call('run', { run: invoked.run });
      while (run.status !== 'done' && run.status !== 'failed' && Date.now() < deadline) {
        await settle(page, 1000);
        run = await ctx.api.hub.call('run', { run: invoked.run });
      }
      check(run.status === 'done', `web/read finished (it is ${run.status})`);
      const result = run.outcome?.status === 'done' ? run.outcome.result : undefined;
      check(typeof result === 'object' && result !== null && !Array.isArray(result) && result['rendered'] === true, 'the page went through the headless browser');
      await open(ctx, `/chat/${session.id}`, 'main');
      const card = `[data-testid="run-card"][data-run="${invoked.run}"]`;
      // finished cards may start folded to their summary line
      await page.waitForSelector(card, { timeout: 15_000 });
      await (await page.$(`${card} [aria-label="Expand"]`))?.click();
      const fetched = await page.waitForSelector(`${card} ${tid('web-fetched')}, ${card} .fetched`, { timeout: 30_000 });
      check(fetched !== null, 'the card shows what it fetched');
      check((await fetched.evaluate((el) => el.textContent)).includes('example.com'), 'the card lists the fetched URL');
      await fetched.scrollIntoView();
      await ctx.shot('web-read');
    }
  },
});
