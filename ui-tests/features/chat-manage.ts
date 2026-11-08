/**
 * Managing a chat (chat-features 1.1, 1.4, 9.4, 9.5): the meta row under the composer names the agent and the model
 * it answers with; its agent menu switches to another agent (fs/explore); the chat's settings pick a model of the
 * chat's own and go back to the agent's; and the header menu deletes the chat after asking, leaving for the list.
 */
import { check, feature, find, hasListColumn, open, settle, tid, type FeatureContext } from '../kit.ts';

/** Click Change in the chat's settings, optionally search, and pick the first picker row `row` matches; the picker closes. */
async function chooseModel(ctx: FeatureContext, row: string, search?: string): Promise<void> {
  const { page } = ctx;
  await page.click(tid('change-model'));
  await page.waitForFunction(() => new URLSearchParams(location.search).get('panel') === 'model', { timeout: 10_000 });
  await find(page, 'model-picker');
  if (search !== undefined) { await page.type(`${tid('model-search')} input`, search); }
  await settle(page);
  const target = await page.waitForSelector(`${tid('model-picker')} ${row}`, { timeout: 10_000 });
  check(target !== null, 'the picker offers a model to pick');
  await target.click();
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('panel'), { timeout: 10_000 });
  await settle(page, 600);
}

export default feature({
  id: 'chat-manage', ref: 'chat-features 1.1, 1.4, 9.4, 9.5', title: 'Switch agent and model, delete a chat',
  async run(ctx) {
    const { page, api } = ctx;
    const made = await api.hub.call('createSession', { title: `UI manage ${Date.now().toString(36)}` });
    await open(ctx, `/chat/${made.id}`, tid('composer-meta'));

    // the agent menu lists the agents, the current one first
    await page.click(tid('agent-picker'));
    await page.waitForSelector('[role="menu"] [role="menuitem"]', { timeout: 5_000 });
    const agents = await page.$$eval('[role="menu"] [role="menuitem"]', (items) => items.map((i) => i.textContent.trim()));
    check(agents[0] === 'Chat agent', `the current agent comes first (saw ${agents.join(', ')})`);
    check(agents.includes('Explore agent'), 'fs/explore is offered as an agent');
    await settle(page, 300);
    await ctx.shot('agent-menu');
    await page.click('[role="menu"] ::-p-text(Explore agent)');
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-picker"]')?.textContent.includes('Explore agent') === true, { timeout: 10_000 });
    check((await api.hub.call('session', { session: made.id })).agent === 'fs/explore', 'the hub has the new agent');

    // the chat's settings name its model; Change opens the model picker, and a pick is kept by the hub and the page
    const settingsModel = (): Promise<string> => page.$eval(tid('session-model'), (el) => el.textContent.trim());
    await page.goto(ctx.url(`/chat/${made.id}?panel=settings`), { waitUntil: 'networkidle0' });
    await find(page, 'session-model');
    check((await settingsModel()).startsWith('Agent’s model'), 'a new chat answers with the agent’s model');
    await chooseModel(ctx, '[data-model]:not([data-model="default"])', 'free');
    const stored = (await api.hub.call('session', { session: made.id })).model;
    check(stored !== undefined && 'model' in stored, 'the hub keeps the chat’s model');
    const picked = stored.model;
    await page.goto(ctx.url(`/chat/${made.id}?panel=settings`), { waitUntil: 'networkidle0' });
    await find(page, 'session-model');
    const name = await settingsModel();
    check(!name.startsWith('Agent’s model'), `the settings name the chat’s model (saw "${name}")`);
    await settle(page);
    await ctx.shot('model');
    await page.reload({ waitUntil: 'networkidle0' });
    await find(page, 'session-model');
    check((await settingsModel()) === name, 'the model is still shown after a reload');
    const kept = (await api.hub.call('session', { session: made.id })).model;
    check(kept !== undefined && 'model' in kept && kept.model === picked, 'the hub still has it after a reload');
    // back to the agent's own choice clears the chat's model
    await chooseModel(ctx, '[data-model="default"]');
    check((await api.hub.call('session', { session: made.id })).model === undefined, 'going back to the agent’s model clears the chat’s');
    await page.goto(ctx.url(`/chat/${made.id}?panel=settings`), { waitUntil: 'networkidle0' });
    await find(page, 'session-model');
    check((await settingsModel()).startsWith('Agent’s model'), 'the settings name the agent’s model again');
    await page.click(tid('panel-close'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('panel'));
    await settle(page, 600);
    if (hasListColumn(ctx)) {
      // with the panel closed the meta row has room to name the model; the agent's own choice says so
      const chip = await page.$eval(tid('model-chip'), (el) => el.textContent.trim());
      check(chip === 'Agent’s model', `the meta row names the model (saw "${chip}")`);
    }

    // the header menu deletes the chat, after asking
    await page.click(tid('chat-menu'));
    await page.waitForSelector('[role="menuitem"]', { visible: true, timeout: 5_000 });
    const items = await page.$$('[role="menuitem"]');
    const labels = await Promise.all(items.map((item) => item.evaluate((n) => n.textContent.trim())));
    const at = labels.findIndex((label) => label.startsWith('Delete chat'));
    check(at >= 0, `the header menu offers Delete chat (has ${labels.join(', ')})`);
    await items[at]?.click();
    await page.waitForSelector('[role="alertdialog"] ::-p-text(Delete “)', { timeout: 5_000 });
    await settle(page, 300);
    await ctx.shot('confirm-delete');
    await page.click(`[role="alertdialog"] ${tid('confirm')}`);
    await page.waitForFunction((id: string) => !location.pathname.includes(id), { timeout: 10_000 }, made.id);
    await settle(page);
    check(await page.$(`[data-testid="session-row"][data-session="${made.id}"]`) === null, 'the deleted chat leaves the list');
    const gone = await api.hub.call('session', { session: made.id }).then(() => false, () => true);
    check(gone, 'the hub no longer has the chat');
    await ctx.shot('deleted');
  },
});
