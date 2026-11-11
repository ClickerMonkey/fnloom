/**
 * Build 6's install cards, rendered (design § Rules): in a chat where a system was installed, fs's install card with
 * what started and its fns, and the update waiting for an admin, whose approval card shows what it adds, the diff,
 * the scan, then what the approval binds (system, host, hashes) and last the scan's code. Against the mock hub (its
 * "Install the dice system" chat, drawn by fs's built client), or a real stack with such a chat.
 */
import { check, feature, find, open, settle, tid } from '../kit.ts';

/** The chat the mock hub seeds with an install and an update waiting for approval. */
const INSTALL_CHAT = 'Install the dice system';

export default feature({
  id: 'build6-install', ref: 'build-6 design 1, Rules', title: 'Install card and its approval card', viewports: ['desktop', 'phone'],
  async run(ctx) {
    const { page } = ctx;
    const sessions = await ctx.api.hub.call('sessions', { limit: 200 });
    const chat = sessions.items.find((s) => s.title === INSTALL_CHAT);
    check(chat !== undefined, `a chat named "${INSTALL_CHAT}" exists`);
    await open(ctx, `/chat/${chat.id}`, tid('thread'));
    await find(page, 'approval-card', 20_000);
    // the card in the chat is cut to the room left; Review shows the whole of it
    if (await page.$(tid('review')) !== null) { await page.click(tid('review')); await find(page, 'approval-review'); }
    const whole = await page.$(tid('approval-review')) === null ? tid('approval-card') : tid('approval-review');
    await page.waitForSelector(`${whole} ${tid('install-subject')}`);
    // the order the install flow asks for: words, diff and scan, then the hashes, then the scan's code
    const order = await page.$eval(`${whole} ${tid('approval-preview')}`, (preview) => {
      const all = [...preview.querySelectorAll('*')];
      const at = (test: (el: Element) => boolean): number => all.findIndex(test);
      return {
        diff: at((el) => el.children.length === 0 && el.textContent.includes('Changes from the running version')),
        scan: at((el) => el.children.length === 0 && el.textContent.includes('Scan (a report')),
        subject: at((el) => el.getAttribute('data-testid') === 'install-subject'),
        code: at((el) => el.tagName === 'PRE'),
      };
    });
    check(order.diff >= 0 && order.scan > order.diff && order.subject > order.scan, `the diff and the scan come before the hashes (${JSON.stringify(order)})`);
    check(order.code < 0 || order.code > order.subject, 'the scan’s code comes after the hashes');
    check((await page.$eval(`${whole} ${tid('install-subject')}`, (el) => el.textContent)).includes('replacing 0.1.0'), 'the card says what the update replaces');
    await settle(page);
    await ctx.shot('approval');
    if (whole === tid('approval-review')) { await page.keyboard.press('Escape'); await settle(page); }

    // the finished install is fs's own card: what started, its fns and a link to its page (a done run opens on a press)
    const done = '[data-testid="run-card"][data-fn="fs/install_system"][data-status="done"]';
    await page.waitForSelector(done);
    await page.$eval(done, (card) => { card.scrollIntoView({ block: 'center' }); });
    if (await page.$(`${done} ${tid('install-open')}`) === null) { await page.click(`${done} button[aria-label="Expand"]`); }
    await find(page, 'install-open');
    const text = await page.$eval(tid('install-open'), (link) => {
      const card = link.closest('[data-testid="install-card"]');
      card?.scrollIntoView({ block: 'center' });
      return card?.textContent ?? '';
    });
    check(text.includes('random') && text.includes('roll'), 'the install card names the system it started and its fns');
    await settle(page);
    await ctx.shot('result');
  },
});
