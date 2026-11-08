/**
 * The context pages (build 2 design 3.5 and 5): every context item, filtered by origin and words; one item with its
 * links both ways; drawing a link from it and seeing it arrive at the other end; removing it again; writing a memory
 * through the dialog; and forgetting it. A memory about another item is made through the API first, so a fresh hub
 * has links to show; everything made is forgotten or removed at the end. At a desktop, a tall tablet and a phone, in
 * light and dark.
 */
import { QualifiedName } from '@harness/core';
import { BUILD_2_VIEWPORTS, check, feature, find, inEachScheme, open, settle, show, tid } from '../kit.ts';

/** The item page's path for a context name. */
const pathOf = (name: string): string => `/context/${name}`;

export default feature({
  id: 'context-items', ref: 'build-2 3.5', title: 'Context items and links', viewports: BUILD_2_VIEWPORTS,
  async run(ctx) {
    const { page, api } = ctx;
    // something to link with: the first item that is not a memory, and a memory about it
    const listed = await api.hub.call('contexts', { limit: 50 });
    const target = listed.items.find((record) => record.origin?.type !== 'memory' && record.disabled !== true);
    check(target !== undefined, 'the hub has a context item to link with');
    const made = await api.hub.call('remember', {
      title: `ui note ${ctx.viewport}`, text: `A note the UI tests wrote at the ${ctx.viewport} size.`, scope: 'user', about: [{ kind: 'context', name: target.name }],
    });
    const written: QualifiedName[] = [made.name];
    try {
      await inEachScheme(ctx, async (shot) => {
        await open(ctx, '/context', tid('context-row'));
        check(await page.$$eval(tid('context-row'), (rows) => rows.length) > 1, 'the list shows context items');
        await shot('list');

        await open(ctx, '/context?q=origin:memory', tid('context-row'));
        const origins = await page.$$eval(tid('context-row'), (rows) => rows.map((row) => row.getAttribute('data-context') ?? ''));
        check(origins.length > 0 && origins.every((name) => name.startsWith('memory/')), `the memory filter shows only memories (got ${origins.join(', ')})`);
        await shot('memories');

        await open(ctx, pathOf(made.name), tid('context-item'));
        check(await page.$$eval(`${tid('links-out')} ${tid('context-link')}`, (els) => els.length) >= 1, 'the memory links to what it is about');
        await shot('memory');

        await open(ctx, pathOf(target.name), tid('context-item'));
        const backlinks = await page.$$eval(`${tid('links-in')} ${tid('context-link')}`, (els) => els.map((el) => el.textContent));
        check(backlinks.some((text) => text.includes(made.name)), `the item lists the memory among its links in (got ${backlinks.length})`);
        await show(page, tid('links-in'));
        await shot('item-links');
      });

      // draw a link from the memory to the item's first fn or context link, through the dialog
      await open(ctx, pathOf(made.name), tid('context-item'));
      const before = await page.$$eval(`${tid('links-out')} ${tid('context-link')}`, (els) => els.length);
      await page.click(tid('add-link'));
      await find(page, 'link-form');
      await page.click(`${tid('link-kind')} [role="radio"]:nth-child(2)`);
      await page.type(`${tid('link-target')} input`, 'fs/read');
      await page.select(`${tid('link-relation')} select`, 'suggests');
      await settle(page);
      await ctx.shot('add-link');
      await page.click(tid('link-save'));
      await page.waitForFunction((n: number) => document.querySelectorAll('[data-testid="links-out"] [data-testid="context-link"]').length > n, { timeout: 15_000 }, before);
      check(!new URL(page.url()).searchParams.has('link'), 'saving closes the dialog (and its URL key)');
      await settle(page);
      await ctx.shot('linked');

      // remove the drawn link again
      await show(page, `${tid('links-out')} ${tid('remove-link')}`);
      await page.click(`${tid('links-out')} ${tid('remove-link')}`);
      await page.waitForFunction((n: number) => document.querySelectorAll('[data-testid="links-out"] [data-testid="context-link"]').length === n, { timeout: 15_000 }, before);

      // write a memory through the dialog; it opens on the new memory's page
      await open(ctx, '/context?remember=1', tid('memory-form'));
      await page.type(`${tid('memory-title')} input`, `ui dialog note ${ctx.viewport}`);
      await page.type(`${tid('memory-text')} textarea`, 'Written through the remember dialog.');
      await settle(page);
      await ctx.shot('remember');
      // every other context option folds under Advanced, tied fns included
      await page.click(tid('memory-advanced'));
      await find(page, 'memory-fns');
      await settle(page);
      await ctx.shot('remember-advanced');
      await page.click(tid('memory-save'));
      await page.waitForFunction(() => location.pathname.startsWith('/context/memory/'), { timeout: 15_000 });
      await find(page, 'context-text');
      const opened = QualifiedName.safeParse(decodeURIComponent(new URL(page.url()).pathname.replace(/^\/context\//, '')));
      if (opened.success) { written.push(opened.data); }
      await settle(page);
      await ctx.shot('remembered');

      // forget it, after asking
      await page.click(tid('memory-forget'));
      await find(page, 'confirm');
      await page.click(tid('confirm'));
      await find(page, 'context-forgotten');
      await ctx.shot('forgotten');
    } finally {
      for (const name of written) { await api.hub.call('forget', { name }).catch(() => undefined); }
    }
  },
});
