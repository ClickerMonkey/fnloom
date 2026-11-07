/**
 * Every page tied to the URL (chat-features 1.2) beyond the chat drawer: the admin views (a system's tabs, the runs,
 * LLM call and resource filters with an item open and its tab, the limits and models tabs, the models search),
 * Settings sections, the Inbox filter, and the chat list's search and Archived view. Each filter is typed or picked
 * the way a person does, so the URL is checked to follow the page, then a reload must bring back the same place: the
 * same address, and the same values in the page's fields and tabs.
 */
import type { Page } from 'puppeteer';
import { check, feature, isPhone, open, settle, type FeatureContext } from '../kit.ts';

/** What a page shows of its state: the values in its fields, and which tabs and segments are chosen. */
function stateOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) { return ''; }
    const fields = [...main.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not([type=hidden]), select')].map((el) => `${el.getAttribute('aria-label') ?? el.id}=${el.value}`);
    const chosen = [...main.querySelectorAll('[aria-selected="true"], [aria-pressed="true"], [aria-checked="true"][role="radio"], [aria-current="page"]')].map((el) => el.textContent.trim());
    return JSON.stringify({ fields, chosen });
  });
}

/** Reload and check the address and the page's state are what they were. */
async function survivesReload(ctx: FeatureContext, what: string, ready: string): Promise<void> {
  const { page } = ctx;
  await settle(page, 500);
  const url = page.url();
  const before = await stateOf(page);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector(ready, { timeout: 20_000 });
  await settle(page, 600);
  check(page.url() === url, `${what}: the address changed on reload (${url} → ${page.url()})`);
  const after = await stateOf(page);
  check(after === before, `${what}: the page came back different after a reload (${before} → ${after})`);
}

/** Type into a labelled search field the way a person does. */
async function typeInto(page: Page, label: string, text: string): Promise<void> {
  const field = await page.waitForSelector(`main ::-p-aria([name="${label}"][role="searchbox"])`, { timeout: 10_000 });
  check(field !== null, `no ${label} field`);
  await field.click({ count: 3 });
  await page.keyboard.type(text);
}

/** Wait until the address carries a query value. */
async function urlHas(page: Page, key: string, value: string, what: string): Promise<void> {
  await page.waitForFunction((k, v) => new URL(location.href).searchParams.get(k) === v, { timeout: 10_000 }, key, value)
    .catch(() => { throw new Error(`${what}: ${key}=${value} never reached the URL (it is ${page.url()})`); });
}

export default feature({
  id: 'url-reload', ref: 'chat-features 1.2', title: 'Refresh returns to the same place on every page',
  async run(ctx) {
    const { page, fixtures } = ctx;

    // a system's tab is its own address
    await open(ctx, '/admin/systems/fs/config', 'main');
    await survivesReload(ctx, 'the fs config tab', 'main');
    await ctx.shot('system-tab');

    // runs: a filter typed in, then a run opened on its Timeline tab
    await open(ctx, '/admin/runs', 'main');
    await typeInto(page, 'Fn', 'fs/bash');
    await urlHas(page, 'fn', 'fs/bash', 'the runs filter');
    await page.goto(ctx.url(`/admin/runs?fn=fs%2Fbash&run=${fixtures.bashRun}`), { waitUntil: 'networkidle0' });
    await settle(page, 600);
    await survivesReload(ctx, 'the runs filter with a run open', 'main');
    await ctx.shot('runs');

    // LLM calls: the model filter typed in
    await open(ctx, '/admin/llm', 'main');
    await typeInto(page, 'Model', 'free');
    await urlHas(page, 'model', 'free', 'the LLM calls filter');
    await survivesReload(ctx, 'the LLM calls filter', 'main');
    await ctx.shot('llm');

    // resources: a search typed in
    await open(ctx, '/admin/resources', 'main');
    await typeInto(page, 'Search', 'README');
    await urlHas(page, 'q', 'README', 'the resources search');
    await survivesReload(ctx, 'the resources search', 'main');
    await ctx.shot('resources');

    // models and limits keep their tabs; the models search is in the URL too
    await open(ctx, '/admin/models/models?q=free', 'main');
    await survivesReload(ctx, 'the models tab and search', 'main');
    await open(ctx, '/admin/limits/resolved', 'main');
    await survivesReload(ctx, 'the limits tab', 'main');
    await ctx.shot('limits');

    // settings sections and the inbox's unread filter
    await open(ctx, '/settings/notifications', 'main');
    await survivesReload(ctx, 'a settings section', 'main');
    await open(ctx, '/inbox?filter=unread', 'main');
    await survivesReload(ctx, 'the inbox unread filter', 'main');
    await ctx.shot('inbox-unread');

    // the chat list: its search and its Archived view (the list is the page on a phone, a column on a desktop)
    await open(ctx, isPhone(ctx) ? '/chat' : `/chat/${fixtures.session}`, 'main');
    await typeInto(page, 'Search chats', 'UI');
    await urlHas(page, 'q', 'UI', 'the chat search');
    await page.click('[aria-label="Which chats"] ::-p-aria([name="Archived"][role="radio"])');
    await urlHas(page, 'chats', 'archived', 'the Archived view');
    await survivesReload(ctx, 'the chat list search and Archived view', 'main');
    await ctx.shot('chat-list');
    await page.click('[aria-label="Which chats"] ::-p-aria([name="Active"][role="radio"])');
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('chats'));
  },
});
