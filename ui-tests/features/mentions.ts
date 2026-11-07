/**
 * Mentions (chat-features 5.3, 5.4, 5.5): `@` searches files and picking one puts it in the draft; a sent mention shows
 * as a chip with a hover card, which offers the methods of the file's type (fs/Entry's Reveal) to run on it.
 */
import { QualifiedName } from '@harness/core';
import { clientInfo } from '../../scripts/session.ts';
import { check, clearComposer, compose, feature, find, isPhone, newChat, openSession, point, settle, tid } from '../kit.ts';

export default feature({
  id: 'mentions', ref: 'chat-features 5.3, 5.4', title: '@ mentions with search and hover cards',
  async run(ctx) {
    const { page, api } = ctx;
    await openSession(ctx);
    await compose(page, 'Look at @READ');
    await page.waitForSelector(tid('picker-mention'), { timeout: 15_000 });
    await settle(page);
    const options = await page.$$eval(tid('picker-mention'), (els) => els.map((el) => el.textContent));
    check(options.some((o) => o.includes('README')), 'searching README offers README.md');
    await ctx.shot('picker');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="composer-picker"]') === null);
    const draft = await page.$eval(tid('composer-input'), (el) => (el instanceof HTMLTextAreaElement ? el.value : ''));
    check(draft.includes('README.md'), `picking puts the file in the draft (got "${draft}")`);
    await ctx.shot('picked');
    await clearComposer(page);

    // a sent mention is a chip in the thread, with a hover card
    const provider = QualifiedName.parse('fs/files');
    const session = await newChat(ctx);
    const [readme] = (await api.hub.call('mentions', { session, provider, query: 'README' })).filter((o) => o.label.endsWith('README.md'));
    check(readme !== undefined, 'the hub finds README.md to mention');
    await api.hub.call('control', { session, action: 'pause' });
    await api.hub.call('send', { session, parts: [{ type: 'text', text: 'Look at ' }, { type: 'mention', provider, label: readme.label, target: readme.target }], client: clientInfo() });
    await find(page, 'mention-chip');
    if (isPhone(ctx)) { await page.tap(tid('mention-chip')); } else { await point(ctx, tid('mention-chip')); }
    await find(page, 'hover-card');
    await page.waitForSelector(`${tid('hover-methods')} button`, { timeout: 10_000 });
    const methods = await page.$$eval(`${tid('hover-methods')} button`, (els) => els.map((el) => el.textContent.trim()));
    check(methods.some((m) => m.startsWith('Reveal')), `the card offers the file type's methods (saw ${methods.join(', ')})`);
    await settle(page);
    await ctx.shot('hover-card');
    await page.keyboard.press('Escape');
  },
});
