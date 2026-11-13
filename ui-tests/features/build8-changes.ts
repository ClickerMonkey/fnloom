/**
 * Build 8, rendered: a `bash` card with the files it changed (a tab per text file with its diff, then the binary,
 * sensitive and maybe-another-call's files listed without one, dotfile paths in their own order), and a `bash` call
 * waiting for approval with the sensitive files it touches. Layout at phone and desktop width, light and dark, can only
 * be checked rendered; the behaviour is covered by component tests. Against the mock hub's samples.
 */
import type { Page } from 'puppeteer';
import { check, feature, inEachScheme, open, settle, tid } from '../kit.ts';

const CHANGES = '[aria-label="Files changed"]';
/** The finished bash run's card (a done run opens on a press). */
const DONE = '[data-testid="run-card"][data-fn="fs/bash"][data-status="done"]';

/** Whether the page scrolls sideways (it never should). */
function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

export default feature({
  id: 'build8-changes', ref: 'build-8 design §3, §4', title: 'Changes after bash and approvals for sensitive files', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    await open(ctx, '/chat', tid('session-row'));
    const session = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="session-row"]')].find((row) => row.textContent.includes('Tidy the routes'))?.dataset['session']);
    check(typeof session === 'string', 'the mock lists the chat with a bash run');
    await inEachScheme(ctx, async (shot) => {
      await open(ctx, `/chat/${String(session)}`, DONE);
      if (await page.$(`${DONE} ${CHANGES}`) === null) { await page.click(`${DONE} button[aria-label="Expand"]`); }
      await page.waitForSelector(CHANGES);
      await (await page.$(CHANGES))?.scrollIntoView();
      await settle(page);
      check(await page.$$eval(`${CHANGES} [role="tab"]`, (tabs) => tabs.length) === 2, 'a tab per diffed file');
      // the rtl ellipsis trick must not move a dotfile's leading dot: the isolate keeps ".env" as written
      const inOrder = await page.$$eval(`${CHANGES} .other .where bdi`, (cells) => cells.length === 3 && cells.every((cell) => {
        const text = cell.firstChild;
        if (!(text instanceof Text) || text.length < 2) { return true; }
        const at = (i: number): number => { const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1); return range.getBoundingClientRect().left; };
        return at(0) < at(1);
      }));
      check(inOrder, 'dotfile paths read as written (the leading dot stays first)');
      check(!await scrollsSideways(page), 'the chat with changes fits the screen');
      await shot('changes');
      await (await page.$(`${CHANGES} .others`))?.scrollIntoView();
      await settle(page);
      await shot('changes-list');

      await page.waitForSelector(tid('sensitive-files'));
      await (await page.$(tid('sensitive-files')))?.scrollIntoView();
      await settle(page);
      check(!await scrollsSideways(page), 'the approval for sensitive files fits the screen');
      await shot('sensitive');
      // a long card is read whole in Review before it can be approved
      if (await page.$(tid('review')) !== null) {
        await page.click(tid('review'));
        await page.waitForSelector(`${tid('approval-review')} ${tid('sensitive-files')}`);
        await settle(page);
        check(await page.$$eval(`${tid('approval-review')} ${tid('sensitive-file')}`, (rows) => rows.length) === 3, 'each sensitive file has a row');
        await shot('sensitive-review');
        await page.keyboard.press('Escape');
      }
    });
  },
});
