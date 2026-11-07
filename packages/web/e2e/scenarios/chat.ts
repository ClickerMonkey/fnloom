/**
 * The chat: open a session from the list (a drawer on phones), read its history, send a message and watch the answer
 * stream in with its run going live, open the run's details from its card (the URL keeps it across a reload), look
 * at the turn's tree, and open the `@` picker. Checks the layout at each step and that the composer stays on screen.
 */
import type { Scenario } from '../harness.ts';
import { check, settle, signedIn } from './steps.ts';

export const chat: Scenario = {
  name: 'chat',
  description: 'Sessions, history, a streamed answer with a live run, the run drawer tied to the URL, the tree and the @ picker.',
  async run(ctx) {
    const { page } = ctx;
    let at = 'start';
    /** Name the step, so a failure says where it happened. */
    const shot = async (name: string): Promise<void> => { at = name; await ctx.shot(name); };
    try {
      await steps();
    } catch (error) {
      throw new Error(`after "${at}": ${error instanceof Error ? error.message : 'failed'}`, { cause: error });
    }

    async function steps(): Promise<void> {
    await signedIn(ctx, '/chat');
    await shot('list');

    await page.waitForSelector('[data-testid="session-row"] .open');
    await page.click('[data-testid="session-row"] .open');
    await page.waitForSelector('[data-testid="assistant-answer"]');
    await settle(page, 600);
    await shot('history');
    check(await page.$$eval('[data-testid="assistant-answer"]', (els) => els.length) >= 1, 'the history should show the earlier answer');

    // a draft left from an earlier run is kept per chat; start from an empty box
    await page.$eval('[data-testid="composer-input"]', (el) => { if (el instanceof HTMLTextAreaElement) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.type('[data-testid="composer-input"]', 'Read the docs and sum them up');
    // on touch screens Enter breaks the line and the button sends
    if (ctx.viewport === 'desktop') { await page.keyboard.press('Enter'); } else { await page.click('[data-testid="send"]'); }
    await page.waitForSelector('[data-testid="run-card"][data-status="running"]', { timeout: 5_000 });
    await shot('running');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="assistant-answer"]').length >= 2 && document.querySelector('[data-testid="session-status"]') === null, { timeout: 15_000 });
    await settle(page, 600);
    await shot('answered');
    const composerInView = await page.$eval('[data-testid="composer"]', (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1; });
    check(composerInView, 'the composer should be fully on screen');

    const cards = await page.$$('[data-testid="run-card"] .summary');
    const last = cards.at(-1);
    check(last !== undefined, 'the new answer should have a run card');
    await last?.click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has('run'));
    await page.waitForSelector('[data-testid="run-details"]');
    await settle(page);
    await shot('run');
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-testid="run-details"]');
    await settle(page);
    await page.click('[data-testid="panel-close"]');
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('run'));
    await settle(page);

    if (ctx.viewport === 'desktop') {
      await page.click('[data-testid="open-tree"]');
      await page.waitForSelector('[data-testid="turn-tree"] [data-testid="tree-node"]');
      await settle(page);
      await shot('tree');
      await page.click('[data-testid="panel-close"]');
      await page.waitForFunction(() => !location.pathname.endsWith('/tree'));
    } else {
      await page.click('[data-testid="open-sessions"]');
      await page.waitForSelector('[role="dialog"][aria-label="Chats"]');
      await settle(page);
      await shot('drawer');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Chats"]') === null);
    }

    await page.click('[data-testid="composer-input"]');
    await page.type('[data-testid="composer-input"]', 'Look at @harn');
    await page.waitForSelector('[data-testid="picker-mention"]');
    await settle(page);
    await shot('mention');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="composer-picker"]') === null);
    await page.keyboard.press('Escape');
    }
  },
};
