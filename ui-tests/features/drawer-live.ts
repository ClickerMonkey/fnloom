/**
 * The run drawer stays live (chat-features 4.6): opened while a run goes, its elapsed time counts up with the card's,
 * and when the run settles the drawer shows its result without being opened again.
 */
import { QualifiedName } from '@harness/core';
import { Approver, clientInfo, finished, SessionWatch } from '../../scripts/session.ts';
import { check, feature, find, newChat, settle, textOf, tid } from '../kit.ts';

/** Seconds of a duration as the drawer writes it ("850ms", "4.2s", "1m 05s"). */
function seconds(text: string): number {
  const minutes = /(\d+)m\s*(\d+)s/.exec(text);
  if (minutes !== null) { return Number(minutes[1]) * 60 + Number(minutes[2]); }
  const secs = /([\d.]+)s/.exec(text);
  if (secs !== null) { return Number(secs[1]); }
  const ms = /(\d+)ms/.exec(text);
  return ms === null ? Number.NaN : Number(ms[1]) / 1000;
}

export default feature({
  id: 'drawer-live', ref: 'chat-features 4.6', title: 'An open run drawer follows its run',
  async run(ctx) {
    const { page, api } = ctx;
    const session = await newChat(ctx);
    const watch = new SessionWatch(api, session);
    try {
      const approver = new Approver(api, watch);
      await approver.during((async () => {
        const invoked = await api.hub.call('invoke', { session, fn: QualifiedName.parse('fs/bash'), args: { command: 'sleep 6; echo drawer-live' }, client: clientInfo() });
        await page.waitForSelector(`[data-testid="run-card"][data-run="${invoked.run}"][data-status="running"]`, { timeout: 30_000 });
        await page.goto(ctx.url(`/chat/${session}?run=${invoked.run}`), { waitUntil: 'networkidle0' });
        await find(page, 'run-elapsed');
        const first = seconds(await textOf(page, 'run-elapsed'));
        await settle(page, 2_500);
        const later = seconds(await textOf(page, 'run-elapsed'));
        check(later - first >= 1.5, `the drawer's elapsed time counts up (${first}s, then ${later}s)`);
        await ctx.shot('running');
        await watch.next('run', (e) => e.run === invoked.run && finished(e.update), 60_000);
        await page.waitForSelector(`${tid('run-details')}[data-status="done"]`, { timeout: 15_000 });
        await page.waitForFunction(() => document.querySelector('[data-testid="run-details"]')?.textContent.includes('drawer-live') === true, { timeout: 15_000 });
        check(!(await page.$eval(tid('run-details'), (el) => el.textContent)).includes('Running for'), 'the settled drawer says how long it took');
        return invoked;
      })());
      await settle(page);
      await ctx.shot('done');
    } finally {
      watch.stop();
    }
  },
});
