/**
 * Managing a chat (chat-features 1.1, 1.4, 9.4, 9.5): the meta row under the composer names the agent and the model
 * it answers with; its agent menu switches to another agent (fs/explore); the chat's settings pick a model of the
 * chat's own and go back to the agent's; and the header menu deletes the chat after asking, leaving for the list.
 */
import { check, feature, open, settle, tid } from '../kit.ts';

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

    // the chat's settings pick a model of its own; the meta row shows it, and it survives a reload
    await page.goto(ctx.url(`/chat/${made.id}?panel=settings`), { waitUntil: 'networkidle0' });
    const model = await page.waitForSelector(`${tid('session-model')} select, select${tid('session-model')}`, { timeout: 15_000 });
    check(model !== null, 'the settings have a model picker');
    const options = await model.evaluate((el) => (el instanceof HTMLSelectElement ? [...el.options].map((o) => ({ value: o.value, label: o.label })) : []));
    check(options[0]?.value === 'default', 'the first choice is the agent’s own model');
    const pick = options.find((o) => o.value.startsWith('model:') && o.label.includes('free')) ?? options[1];
    check(pick !== undefined, 'the hub offers at least one model');
    await model.select(pick.value);
    await settle(page, 600);
    const stored = (await api.hub.call('session', { session: made.id })).model;
    check(stored !== undefined && 'model' in stored && `model:${stored.model}` === pick.value, 'the hub keeps the chat’s model');
    await settle(page);
    await ctx.shot('model');
    await page.reload({ waitUntil: 'networkidle0' });
    const again = await page.waitForSelector(`${tid('session-model')} select, select${tid('session-model')}`, { timeout: 15_000 });
    check((await again?.evaluate((el) => (el instanceof HTMLSelectElement ? el.value : ''))) === pick.value, 'the model is still chosen after a reload');
    await again?.select('default');
    await settle(page, 600);
    check((await api.hub.call('session', { session: made.id })).model === undefined, 'going back to the agent’s model clears the chat’s');
    await page.click(tid('panel-close'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('panel'));
    await settle(page, 600);
    if (ctx.viewport === 'desktop') {
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
