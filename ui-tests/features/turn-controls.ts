/**
 * Stopping and moving work aside (chat-features 4.11, 5.2, 6.2): while a slow command runs, Stop offers what the run
 * allows (Pause when it can, Cancel always) and Cancel ends it, the card saying so; a second slow command moved to the
 * background shows in the strip above the composer and in the meta row's count, live, and opening it from the strip
 * opens its details (in the URL). A command the shell setting asks about is answered from its yes-or-no card first.
 * Cancelling waits for the system to stop the command, which can take until the command ends on its own.
 */
import type { Page } from 'puppeteer';
import { check, compose, feature, find, newChat, settle, show, tid } from '../kit.ts';

/** Start `!bash` with a command from its form, saying yes when the shell setting asks first. */
async function runCommand(page: Page, command: string): Promise<string> {
  const known = new Set(await page.$$eval(tid('run-card'), (cards) => cards.map((c) => c.getAttribute('data-run') ?? '')));
  await compose(page, '!bash');
  await page.waitForSelector(tid('picker-invoke'), { timeout: 10_000 });
  await page.keyboard.press('Enter');
  await find(page, 'invocation-form');
  const field = await page.$(`${tid('invocation-form')} textarea, ${tid('invocation-form')} input[type="text"]`);
  check(field !== null, 'the form has a field for the command');
  await field.click();
  await field.type(command);
  await page.click(tid('gin-submit'));
  // the shell may ask first (the card then waits on the person), so say yes whenever it asks, until the run is running
  // with nothing left to answer
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const yes = await page.$(tid('handler-yes'));
    if (yes !== null) { await yes.click(); await settle(page, 300); continue; }
    const running = await page.$$eval('[data-testid="run-card"][data-status="running"]', (cards, seen) => cards.map((c) => c.getAttribute('data-run') ?? '').find((id) => !seen.includes(id)), [...known]);
    if (running !== undefined) {
      await settle(page, 1_500);
      if (await page.$(tid('handler-card')) === null && await page.$(`[data-run="${running}"][data-status="running"]`) !== null) { return running; }
      continue;
    }
    await settle(page, 250);
  }
  throw new Error(`"${command}" never got running`);
}

export default feature({
  id: 'turn-controls', ref: 'chat-features 4.11, 5.2, 6.2', title: 'Stop, pause and background work',
  async run(ctx) {
    const { page } = ctx;
    const session = await newChat(ctx);

    // Stop: its menu offers what the run allows; Cancel ends the run and the card says so
    const first = await runCommand(page, 'sleep 20; echo never');
    const stop = await find(page, 'stop');
    await show(page, tid('stop'));
    await ctx.shot('running');
    await stop.click();
    await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 5_000 });
    const offered = await page.$$eval('[role="menu"] [role="menuitem"]', (items) => items.map((i) => i.textContent.trim()));
    check(offered.some((o) => o.startsWith('Cancel')), `Stop offers Cancel (saw ${offered.join(', ')})`);
    await settle(page, 300);
    await ctx.shot('stop-menu');
    if (offered.some((o) => o.startsWith('Pause'))) {
      await page.click('[role="menu"] ::-p-text(Pause)');
      await find(page, 'resume', 15_000);
      await ctx.shot('paused');
      await page.click(tid('resume'));
      await find(page, 'stop', 15_000);
      await page.click(tid('stop'));
      await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 5_000 });
    }
    await page.click('[role="menu"] ::-p-text(Cancel)');
    await page.waitForSelector(`[data-testid="run-card"][data-run="${first}"][data-status="cancelled"]`, { timeout: 45_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="stop"]') === null, { timeout: 30_000 });
    await show(page, `[data-run="${first}"]`);
    await ctx.shot('cancelled');

    // Background: the run leaves the turn and shows in the strip and the meta row, live
    const second = await runCommand(page, 'sleep 30; echo bg-done');
    const toBackground = await page.waitForSelector(`[data-run="${second}"] [aria-label="Move to background"]`, { timeout: 10_000 });
    check(toBackground !== null, 'a running card offers to move it to the background');
    await toBackground.click();
    await find(page, 'background-strip', 15_000);
    check((await page.$eval(tid('background-strip'), (el) => el.textContent)).includes('Bash'), 'the strip names the background run');
    check(await page.$(tid('background-count')) !== null, 'the meta row counts the background run');
    check((await page.$eval(`[data-run="${second}"]`, (el) => el.textContent)).includes('background'), 'the card is tagged as background');
    await show(page, tid('background-strip'));
    await ctx.shot('background');
    await page.click(`${tid('background-strip')} [data-run="${second}"]`);
    await page.waitForFunction((run: string) => new URL(location.href).searchParams.get('run') === run, { timeout: 10_000 }, second);
    await find(page, 'run-details');
    await settle(page);
    await ctx.shot('background-open');
    await page.click(tid('panel-close'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('run'));

    // a background run can be stopped from the session too; the strip empties once it settles
    await ctx.api.hub.call('control', { session, action: 'cancel' });
    await page.waitForFunction(() => document.querySelector('[data-testid="background-strip"]') === null, { timeout: 60_000 });
    await ctx.shot('strip-gone');
  },
});
