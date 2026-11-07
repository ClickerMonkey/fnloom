/**
 * Scrolling (chat-features 2.1, 2.2, 2.7): a session opens at the bottom and follows new content while the reader is
 * there (a run card arriving and opening counts as content, not as scrolling away); scrolled up, a card closing above
 * leaves the reader's row where it was, new rows are counted on the "N new" button, and Jump to latest goes back.
 */
import { QualifiedName, type SessionId } from '@harness/core';
import type { Page } from 'puppeteer';
import { clientInfo } from '../../scripts/session.ts';
import { check, feature, find, newChat, settle, textOf, tid, type FeatureContext } from '../kit.ts';

/** How far the thread is from its bottom, in px. */
function fromBottom(page: Page): Promise<number> {
  return page.$eval(tid('thread'), (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** Run `seq` by hand in the chat and wait for its card to finish. */
async function runSeq(ctx: FeatureContext, session: SessionId, lines: number): Promise<void> {
  const { run } = await ctx.api.hub.call('invoke', { session, fn: QualifiedName.parse('fs/bash'), args: { command: `seq 1 ${lines}` }, client: clientInfo() });
  await ctx.page.waitForSelector(`[data-testid="run-card"][data-run="${run}"][data-status="done"]`, { timeout: 60_000 });
}

/** Open every collapsed run card. */
function expandAll(page: Page): Promise<void> {
  return page.$$eval('[data-testid="run-card"] button[aria-label="Expand"]', (buttons) => {
    for (const button of buttons) { if (button instanceof HTMLElement) { button.click(); } }
  });
}

export default feature({
  id: 'scrolling', ref: 'chat-features 2.1, 2.2, 2.7', title: 'Follows at the bottom; keeps your place above',
  async run(ctx) {
    const { page } = ctx;
    const session = await newChat(ctx);
    for (let i = 0; i < 4; i++) { await runSeq(ctx, session, 30); }
    await expandAll(page);
    await settle(page, 600);
    check(await page.$eval(tid('thread'), (el) => el.scrollHeight > el.clientHeight + 200), 'the thread is taller than its box once the cards are open');

    // reload: it opens at the bottom and stays there while cards and their bodies lay out
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'thread', 20_000);
    await expandAll(page);
    await settle(page, 1_200);
    check(await fromBottom(page) < 40, 'a session opens at its latest message and stays there as it lays out');
    await ctx.shot('bottom');

    // at the bottom, a new run arriving and opening is followed
    await runSeq(ctx, session, 30);
    await expandAll(page);
    await settle(page, 800);
    check(await fromBottom(page) < 40, 'the thread follows a card arriving and opening while at the bottom');

    // scrolled up: a card closing above the reader leaves their row in place
    await page.$eval(tid('thread'), (el) => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
      el.scrollTop = Math.round(el.scrollHeight / 2);
    });
    await settle(page, 400);
    await find(page, 'jump-latest');
    const anchor = await page.$eval(tid('thread'), (box) => {
      const top = box.getBoundingClientRect().top;
      const row = [...box.querySelectorAll<HTMLElement>('[data-key]')].find((r) => r.getBoundingClientRect().top >= top);
      return { key: row?.dataset['key'] ?? '', offset: row === undefined ? 0 : row.getBoundingClientRect().top - top };
    });
    check(anchor.key !== '', 'a row is in view');
    await page.$eval('[data-testid="run-card"] button[aria-label="Collapse"]', (button) => { if (button instanceof HTMLElement) { button.click(); } });
    await settle(page, 500);
    const moved = await page.$eval(tid('thread'), (box, kept) => {
      const row = box.querySelector<HTMLElement>(`[data-key="${CSS.escape(kept.key)}"]`);
      return row === null ? Number.POSITIVE_INFINITY : Math.abs(row.getBoundingClientRect().top - box.getBoundingClientRect().top - kept.offset);
    }, anchor);
    check(moved < 3, `the reader's row stays put when a card above it closes (moved ${String(moved)}px)`);
    await ctx.shot('scrolled-up');

    // scrolled up, a new run is counted rather than followed
    await runSeq(ctx, session, 3);
    await settle(page, 500);
    check(/\d+ new/.test(await textOf(page, 'jump-latest')), 'the jump button counts what arrived below');
    check(await fromBottom(page) > 100, 'scrolled up, new content is not followed');
    await ctx.shot('new-below');
    await page.click(tid('jump-latest'));
    await settle(page, 900);
    check(await fromBottom(page) < 40, 'Jump to latest returns to the bottom');
  },
});
