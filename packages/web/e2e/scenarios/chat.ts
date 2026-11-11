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
    // the router chat holds the history this walks through (newer chats sort above it)
    for (const row of await page.$$('[data-testid="session-row"] .open')) {
      if ((await row.evaluate((el) => el.textContent)).includes('Refactor the router')) { await row.click(); break; }
    }
    await page.waitForSelector('[data-testid="assistant-answer"]');
    await settle(page, 600);
    await shot('history');
    check(await page.$$eval('[data-testid="assistant-answer"]', (els) => els.length) >= 1, 'the history should show the earlier answer');
    // what the answer's fns attached: a diff card, and link cards for a resource and a web page
    check(await page.$('[data-testid="attachment"][data-attachment="fs/diff"]') !== null, 'the answer should show its diff attachment');
    const links = await page.$$eval('[data-testid="link-card"]', (els) => els.map((el) => ({ tag: el.tagName, text: el.textContent })));
    check(links.some((l) => l.tag === 'BUTTON' && l.text.includes('routes.ts')), 'a resource link should be a card that opens the viewer');
    check(links.some((l) => l.tag === 'A' && l.text.includes('router.vuejs.org')), 'a web link should be a card that opens the page');
    await page.$eval('button[data-testid="link-card"]', (el) => { el.scrollIntoView({ block: 'center' }); });
    await settle(page, 300);
    await shot('attachments');
    await page.$eval('button[data-testid="link-card"]', (el) => { if (el instanceof HTMLElement) { el.click(); } });
    await page.waitForFunction(() => new URL(location.href).searchParams.has('resource'), { timeout: 5_000 });
    // on a tablet the panel is a sheet sliding in; press Close once it is there
    await page.waitForSelector('[data-testid="panel-close"]', { visible: true });
    await settle(page, 300);
    await page.click('[data-testid="panel-close"]');
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('resource'));

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

    // the answer's fn calls fold into one section once they settle: open the last one
    const groups = await page.$$('[data-testid="run-group-toggle"][aria-expanded="false"]');
    await groups.at(-1)?.click();
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
