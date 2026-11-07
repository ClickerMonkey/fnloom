/**
 * Live run status (chat-features 4.1, 4.3, 4.4, 6.1): a slow command run from its `!` form asks to confirm, then its
 * card shows progress and its latest output line while it runs, the status line sums up what is running, and the
 * card ends done.
 */
import { check, compose, feature, find, newChat, settle, show, statusesSeen, tid, watchStatuses } from '../kit.ts';

/** Prints a line a second, so the card has progress and output to show while it runs. */
const SLOW = 'for i in 1 2 3 4 5; do echo "step-$i"; sleep 1; done; echo live-done';

export default feature({
  id: 'live-runs', ref: 'chat-features 4.1, 4.3, 4.4', title: 'A run card shows its live status and progress',
  async run(ctx) {
    const { page } = ctx;
    await newChat(ctx);
    await watchStatuses(page);
    await compose(page, '!bash');
    await page.waitForSelector(tid('picker-invoke'), { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await find(page, 'invocation-form');
    const field = await page.$(`${tid('invocation-form')} textarea, ${tid('invocation-form')} input[type="text"]`);
    check(field !== null, 'the form has a field for the command');
    await field.click();
    await field.type(SLOW);
    await page.click(tid('gin-submit'));

    // a command outside the safe list asks the person first, as a yes-or-no card with explicit buttons; the run card
    // says it waits on them (not that it is running), then runs once they say yes
    await find(page, 'handler-card', 30_000);
    await show(page, tid('handler-card'));
    check(await page.$eval(tid('handler-card'), (el) => el.getAttribute('data-kind')) === 'confirm', 'the shell confirm is a yes-or-no card');
    const yes = await page.$eval(tid('handler-yes'), (el) => el.textContent.trim());
    check(yes === 'Run', `the yes button says what it does (saw "${yes}")`);
    check(await page.$(tid('handler-no')) !== null, 'the card can be cancelled');
    await page.waitForSelector('[data-testid="run-card"][data-status="waiting"]', { timeout: 10_000 });
    const waiting = await page.$eval('[data-testid="run-card"][data-status="waiting"]', (el) => el.textContent);
    check(waiting.includes('Waiting for your answer'), 'the run card says it waits for the person');
    await ctx.shot('asking');
    await page.click(tid('handler-yes'));
    await page.waitForSelector('[data-testid="run-card"][data-status="running"]', { timeout: 30_000 });
    // the card shows the command's latest line as it prints
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-testid="run-card"][data-status="running"]');
      return card !== null && /step-[2-5]/.test(card.textContent);
    }, { timeout: 20_000 });
    await show(page, '[data-testid="run-card"][data-status="running"]');
    check(await page.$(`[data-testid="run-card"][data-status="running"] ${tid('run-progress')}`) !== null, 'a running card shows its progress');
    const line = await page.$eval(tid('status-line'), (el) => el.textContent.trim());
    check(line.length > 0, 'the status line sums up the running run');
    await ctx.shot('running');

    await page.waitForSelector('[data-testid="run-card"][data-status="done"]', { timeout: 30_000 });
    await settle(page, 600);
    const seen = Object.values(await statusesSeen(page)).find((list) => list.includes('running'));
    check(seen !== undefined, 'the run card was seen running');
    check(seen.indexOf('running') < seen.indexOf('done'), `the card went from running to done (saw ${seen.join(' → ')})`);
    // a finished card folds to its summary line; opened, it shows what the command printed
    const done = '[data-testid="run-card"][data-status="done"]';
    const expand = await page.$(`${done} [aria-label="Expand"]`);
    if (expand !== null) { await expand.click(); await settle(page); }
    check((await page.$eval(done, (el) => el.textContent)).includes('live-done'), 'the finished card shows what the command printed');
    await show(page, done);
    await ctx.shot('done');
  },
});
