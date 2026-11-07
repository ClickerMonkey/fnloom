/**
 * The model picker (chat-features 9.4): the composer's model chip (on a phone, Chat settings → Change) opens a
 * searchable list of chat models with price, context and abilities; "free" narrows it to free models, a filter chip
 * narrows by ability, embedding models are not offered, and picking one saves it and closes the picker.
 */
import { check, count, feature, find, isPhone, openSession, settle, tid } from '../kit.ts';

export default feature({
  id: 'model-picker', ref: 'chat-features 9.4', title: 'Search and pick a model',
  async run(ctx) {
    const { page, fixtures, api } = ctx;
    await openSession(ctx);
    if (isPhone(ctx)) {
      await page.goto(ctx.url(`/chat/${fixtures.session}?panel=settings`), { waitUntil: 'networkidle0' });
      await page.click(tid('change-model'));
    } else {
      await page.click(tid('model-chip'));
    }
    await page.waitForFunction(() => new URLSearchParams(location.search).get('panel') === 'model', { timeout: 10_000 });
    await find(page, 'model-picker');
    await settle(page);
    const listed = await page.$$eval(`${tid('model-picker')} [data-model]`, (els) => els.map((el) => el.textContent.toLowerCase()));
    check(listed.length > 1, 'the picker lists models');
    check(!listed.some((text) => text.includes('embedding')), 'embedding models are not offered as chat models');
    await ctx.shot('picker');

    await page.type(`${tid('model-search')} input`, 'free');
    await settle(page);
    const free = await page.$$eval(`${tid('model-picker')} [data-model]:not([data-model="default"])`, (els) => els.map((el) => el.textContent));
    check(free.length > 0 && free.every((text) => text.includes('Free')), 'searching "free" shows only free models, each priced Free');
    await ctx.shot('free');

    await page.click(`${tid('model-picker')} [data-filter="tools"]`);
    await settle(page);
    check((await count(page, 'model-count')) === 1, 'the picker says how many models match');
    const [pick] = await page.$$(`${tid('model-picker')} [data-model]:not([data-model="default"])`);
    check(pick !== undefined, 'a free model with tools is offered');
    const id = await pick.evaluate((el) => el.getAttribute('data-model') ?? '');
    await pick.click();
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('panel'), { timeout: 10_000 });
    const saved = await api.hub.call('session', { session: fixtures.session });
    check(saved.model !== undefined && 'model' in saved.model && saved.model.model === id, `the chat answers with the picked model (${id})`);
    await settle(page);
    await ctx.shot('picked');
    await api.hub.call('updateSession', { session: fixtures.session, model: null });
  },
});
