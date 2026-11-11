/**
 * The owner's build 5 UI feedback, re-checked in a real browser (build 6): the resources page takes the full width with
 * the tree in a resizable left column and no scroller inside another; opening a file opens it; no Vue unmount error
 * reaches the console; fn calls (bash too) show as cards, in the order the model made them, sequential calls in one
 * collapsed group; any run opens its fn as a modal; one cursor while an answer streams; the chat's fn mode picker
 * saves; approving a run runs it (no second "Run" press).
 */
import type { Page } from 'puppeteer';
import { check, compose, count, feature, find, isPhone, newChat, open, openSession, sendComposer, settle, show, tid } from '../kit.ts';

/** Console messages a page logged that are errors, from now on. */
function consoleErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') { seen.push(message.text()); } });
  page.on('pageerror', (error) => { seen.push(error instanceof Error ? error.message : String(error)); });
  return seen;
}

/** Scroll containers that sit inside another scroll container (the "scroll in a scroll" the owner saw). */
function nestedScrollers(page: Page, root: string): Promise<string[]> {
  return page.$eval(root, (start) => {
    const scrolls = (el: Element): boolean => {
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    };
    const found: string[] = [];
    for (const el of [start, ...start.querySelectorAll('*')]) {
      if (!scrolls(el)) { continue; }
      let up = el.parentElement;
      while (up !== null && up !== document.body) {
        if (scrolls(up)) { found.push(`${el.className} in ${up.className}`); break; }
        up = up.parentElement;
      }
    }
    return found;
  });
}

export default feature({
  id: 'build5-feedback', ref: 'build-5 feedback', title: 'The owner’s build 5 UI feedback', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page, api, fixtures } = ctx;
    const errors = consoleErrors(page);

    // ─── resources: full width, tree in its own resizable column, no nested scroll, a file opens ───
    await open(ctx, '/resources', tid('resources-page'));
    await find(page, 'resource-row');
    await settle(page);
    const width = await page.$eval(tid('resources-page'), (el) => el.getBoundingClientRect().width);
    const main = await page.$eval('main', (el) => el.getBoundingClientRect().width);
    check(width >= main - 2, `the resources page fills its column (${Math.round(width)} of ${Math.round(main)}px)`);
    if (!isPhone(ctx)) {
      check(await count(page, 'folder-tree') === 1, 'the folder tree shows in its own column');
      check(await count(page, 'splitter') >= 1, 'the tree column has a divider to drag');
    }
    const nested = await nestedScrollers(page, tid('resources-page'));
    check(nested.length === 0, `no scroller inside another on the resources page: ${nested.join('; ')}`);
    await ctx.shot('resources');
    await page.click(`${tid('resource-search')} input`);
    await page.keyboard.type('hub-client');
    await page.keyboard.press('Enter');
    // the list settles on the search's answer first (rows shown before it are replaced), then the row is marked and clicked
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="resource-row"]')].some((row) => row.textContent.includes('hub-client.ts')), { timeout: 15_000 });
    await settle(page);
    const marked = await page.$$eval(tid('resource-row'), (rows) => {
      const row = rows.find((r) => r.textContent.includes('hub-client.ts'));
      row?.setAttribute('data-target', 'hub-client');
      return row !== undefined;
    });
    check(marked, 'hub-client.ts is listed');
    // a click on the row (its middle, not only its name) opens the file
    await page.click('[data-testid="resource-row"][data-target="hub-client"]');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('uri')?.includes('hub-client.ts') === true, { timeout: 10_000 });
    await find(page, 'resource-viewer');
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="resource-viewer"]')?.textContent ?? '';
      return text.includes('import') && !text.includes('No connected system');
    }, { timeout: 20_000 });
    await ctx.shot('file-open');

    // ─── the fixture chat: fn calls show (read, bash), in order; a run opens its fn as a modal ───
    await openSession(ctx);
    /** The chat the fn mode picker is in: the fixture chat, or the new one the agent turn ran in. */
    let chat = fixtures.session;
    await find(page, 'run-card');
    check(await page.$(`${tid('run-card')}[data-fn^="fs/read"]`) !== null || await page.$(tid('run-group')) !== null, 'the agent’s fs read call shows (fs/read, or the mock’s fs/read_file)');
    check(await page.$(`${tid('run-card')}[data-run="${fixtures.bashRun}"]`) !== null || await count(page, 'run-message') > 0, 'the bash run shows');
    await show(page, `${tid('run-card')}[data-run="${fixtures.bashRun}"]`);
    await page.click(`${tid('run-card')}[data-run="${fixtures.bashRun}"] .summary`);
    await find(page, 'run-details');
    // a phone's sheet slides in: click its fn link once it is still
    await settle(page);
    await page.click(tid('run-about-fn'));
    await find(page, 'fn-open-page');
    await settle(page);
    await ctx.shot('fn-modal');
    // close the modal, then the run's details (a sheet on a phone)
    await page.keyboard.press('Escape');
    await settle(page);
    await page.keyboard.press('Escape');
    await settle(page);

    // ─── one agent turn: sequential calls fold into a group, in the model's order; approving the bash call runs it
    // (no second press); one cursor while it streams ───
    if (!isPhone(ctx)) {
      chat = await newChat(ctx);
      await compose(page, 'Load fs/read and fs/bash with hub/load_fns. Use fs/read to read package.json, then fs/read to read tsconfig.json, then fs/bash to run exactly: echo approved-once. Then say in one sentence what this project is.');
      const carets: number[] = [];
      const sample = setInterval(() => {
        void page.evaluate(() => document.querySelectorAll('.caret, [data-testid="answer-typing"]').length).then((n) => { carets.push(n); }, () => undefined);
      }, 150);
      try {
        await sendComposer(ctx);
        await find(page, 'approve', 240_000);
        await settle(page);
        await ctx.shot('approval');
        await page.click(tid('approve'));
        // approving runs it, with no other press: the card goes and the turn carries on
        await page.waitForFunction(() => document.querySelector('[data-testid="approval-card"]') === null, { timeout: 20_000 });
        await page.waitForFunction(() => {
          const answers = document.querySelectorAll('[data-testid="assistant-answer"]');
          const last = answers[answers.length - 1];
          return last !== undefined && last.querySelector('[data-testid="answer-typing"]') === null && last.querySelector('.caret') === null && last.querySelector('[data-testid="answer-text"]') !== null;
        }, { timeout: 240_000, polling: 500 });
      } finally {
        clearInterval(sample);
      }
      check(Math.max(0, ...carets) <= 1, `one cursor at a time while the answer streams (saw ${Math.max(0, ...carets)})`);
      const order = await page.evaluate(() => {
        const answers = document.querySelectorAll('[data-testid="assistant-answer"]');
        const last = answers[answers.length - 1];
        if (last === undefined) { return []; }
        return [...last.querySelectorAll('[data-testid="reasoning"], [data-testid="run-card"], [data-testid="run-group"], [data-testid="answer-text"]')]
          .filter((el) => el.parentElement?.closest('[data-testid="run-group"]') === null || el.getAttribute('data-testid') === 'run-group')
          .map((el) => el.getAttribute('data-testid') ?? '');
      });
      const lastText = order.lastIndexOf('answer-text');
      const lastRun = Math.max(order.lastIndexOf('run-card'), order.lastIndexOf('run-group'));
      check(lastText > lastRun, `the closing text comes after the calls it follows (${order.join(', ')})`);
      const loose = order.filter((id) => id === 'run-card').length;
      check(order.includes('run-group') || loose < 2, `calls in a row fold into one group (${order.join(', ')})`);
      const dots = await page.evaluate(() => [...([...document.querySelectorAll('[data-testid="assistant-answer"]')].at(-1)?.querySelectorAll('.run-dot') ?? [])].map((el) => el.getAttribute('data-status')));
      check(dots.length > 0 && dots.every((status) => status === 'done'), `every call ran, the approved bash too (${dots.join(', ')})`);
      await show(page, `${tid('assistant-answer')}:last-of-type`);
      await ctx.shot('sequential');
    }

    // ─── nothing reached the console that the owner saw ───
    const bad = errors.filter((text) => /destructure|bum|Unhandled|TypeError/i.test(text));
    check(bad.length === 0, `no unmount or type errors in the console: ${bad.join(' | ')}`);

    // ─── fn mode picker saves on the session ───
    await page.click(tid('fn-mode-picker'));
    await page.waitForSelector('[role="menuitem"]', { timeout: 5_000 });
    await settle(page, 200);
    await ctx.shot('fn-mode-menu');
    const picked = await page.$$eval('[role="menuitem"]', (items) => {
      const read = items.find((el) => el.textContent.trim().toLowerCase().startsWith('read'));
      if (read instanceof HTMLElement) { read.click(); return true; }
      return false;
    });
    check(picked, 'the fn mode menu offers Read');
    await page.waitForFunction(() => document.querySelector('[data-testid="fn-mode-picker"]')?.textContent.toLowerCase().includes('read') === true, { timeout: 10_000 });
    const session = await api.hub.call('session', { session: chat });
    check(session.fnMode === 'read', `the session's fn mode is read (got ${session.fnMode ?? 'default'})`);
    await api.hub.call('updateSession', { session: chat, fnMode: null });
  },
});
