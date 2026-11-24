/**
 * The schedule system's pages, on a hub where it is live and the person has schedules and at least one firing (run
 * `scripts/schedule-live.ts --keep` first, which leaves such a stack on port 4360): the calendar as a month, a week and
 * an agenda (the agenda is what a phone opens on), one schedule's overview, its history and its edit form, the admin
 * list of every schedule, and the run page of a firing (`/run/:run`), reached from the history.
 */
import { QualifiedName } from '@harness/core';
import { z } from 'zod';
import { check, feature, open, settle, tid } from '../kit.ts';

/** What a firing record says that picks the schedule to shoot. */
const Firing = z.object({ schedule: z.string(), run: z.string().optional() });

export default feature({
  id: 'schedule-pages', ref: 'schedule system, slice 8', title: 'Schedule pages',
  viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    for (const view of ['month', 'week', 'agenda'] as const) {
      await open(ctx, `/s/schedule/calendar?view=${view}`, tid('schedule-toolbar'));
      await page.waitForSelector(view === 'agenda' ? tid('schedule-agenda') : tid('schedule-grid'), { timeout: 15_000 });
      await settle(page, 600);
      await ctx.shot(`calendar-${view}`);
    }
    // the person's schedules: the first one with a history opens on its overview
    const listed = await ctx.api.hub.call('searchFns', { items: ['fn'], kinds: ['schedule/schedule'], visibility: 'mine', available: false, order: 'name', limit: 20 }).catch(() => undefined);
    const names = (listed?.items ?? []).map((hit) => hit.name).filter((name) => name.startsWith('schedule/'));
    check(names.length > 0, 'the person has schedules (run scripts/schedule-live.ts --keep first)');
    // the newest firing that became a run picks the schedule, so its history has a run page to open
    const firings = await ctx.api.hub.call('records', { type: QualifiedName.parse('schedule/Firing'), query: { sort: [{ field: 'at', dir: 'desc' }], limit: 20 } }).catch(() => undefined);
    const ran = firings?.items.map((item) => Firing.safeParse(item.value)).find((parsed) => parsed.success && parsed.data.run !== undefined)?.data?.schedule;
    const reminder: string = names.find((name) => name === ran) ?? names[0] ?? '';
    const local = reminder.slice('schedule/'.length);
    await open(ctx, `/s/schedule/item/${local}`, tid('schedule-item'));
    await ctx.shot('schedule-overview');
    await open(ctx, `/s/schedule/item/${local}?tab=history`, tid('schedule-history'));
    await settle(page, 800);
    await ctx.shot('schedule-history');
    const runLink = await page.$(tid('history-run'));
    await open(ctx, `/s/schedule/item/${local}?edit=1`, tid('schedule-edit-dialog'));
    await ctx.shot('schedule-edit');
    await open(ctx, '/s/schedule/all', tid('all-schedules'));
    await settle(page, 600);
    await ctx.shot('admin-all');
    if (runLink !== null) {
      await open(ctx, `/s/schedule/item/${local}?tab=history`, tid('history-run'));
      await page.click(tid('history-run'));
      await page.waitForSelector(tid('run-page'), { timeout: 15_000 });
      await settle(page, 800);
      check(/\/run\/run_/.test(new URL(page.url()).pathname), 'the history opens the firing\'s run page');
      await ctx.shot('run-page');
    }
  },
});
