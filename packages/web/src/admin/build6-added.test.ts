/**
 * Build 6's "everything a system added" views: a system's context (each with its key, who sees it and its choices) and
 * its named types on its own tabs, read from the hub's lists for the system; a context file's item with its key and its
 * choices; and the models list with the hub roles each model fills, as systems' `ctx.ai()` is told.
 */
import { Json, ModelRoleView, QueryFnArgs, TypeRecord } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { contextRecord, T_CONTEXT } from '../context/test/graph.ts';
import { STORES } from '../state/stores.ts';
import { fakeCaller, fakeStores } from '../test/fakes.ts';
import ModelTable from './components/ModelTable.vue';
import { modelKey, rolesByModel } from './logic/roles.ts';
import { fakeAdmin, fakeAdminApi, model } from './test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });

const KINDS = contextRecord('fs/authoring.kinds', {
  description: 'How kinds work', decl: { title: 'Kinds', visible: 'llm', choices: [{ to: 'fs/guide', when: 'The person asks how to read files' }] },
});
const ENTRY = TypeRecord.parse({ name: 'fs/Entry', system: 'fs', description: 'A file or folder', def: { name: 'obj', props: {} }, display: { label: 'Entry' }, references: [], updatedAt: T_CONTEXT });

/** The admin store whose hub lists answer one system's context and types. */
function adminWithLists() {
  const api = { ...fakeAdminApi(), query: fakeCaller<'query'>((args) => {
    const { list } = QueryFnArgs.parse(args);
    const items = (list === 'contexts' ? [KINDS] : list === 'types' ? [ENTRY] : []).map((item) => Json.parse(item));
    return Promise.resolve({ items, sort: [], total: items.length });
  }) };
  return fakeAdmin({ api });
}

async function open(path: string, admin = adminWithLists()) {
  const fakes = fakeStores({ signedIn: true, admin });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, router };
}

describe('a system page', () => {
  it('lists the context it added with its key, and its types, each from the hub list for the system', async () => {
    const { admin } = await open('/admin/systems/fs/context');
    const query = admin.api.query.calls.map(([args]) => QueryFnArgs.parse(args));
    expect(query[0]).toMatchObject({ list: 'contexts', query: { filters: [{ field: 'system', op: 'is', value: 'fs' }] } });
    const row = document.body.querySelector('[data-testid="system-context"] [data-testid="context-row"]');
    expect(row?.querySelector('.name')?.textContent).toBe('Kinds');
    expect(row?.querySelector('.key')?.textContent).toBe('authoring.kinds');
    expect(row?.textContent).toContain('Seen by agents');
    expect(document.body.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('1');
  });

  it('shows its named types on their own tab', async () => {
    const { admin } = await open('/admin/systems/fs/types');
    expect(QueryFnArgs.parse(admin.api.query.calls.at(-1)?.[0]).query.filters).toEqual([{ field: 'system', op: 'is', value: 'fs' }]);
    expect(document.body.querySelector('[data-type="fs/Entry"]')?.textContent).toContain('A file or folder');
  });
});

describe('a context file item', () => {
  it('shows its title, its key to an admin, who sees it, and its choices opening the item each loads', async () => {
    const fakes = fakeStores({ signedIn: true });
    fakes.context.state.records.unshift(KINDS);
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/context/fs/authoring.kinds');
    await router.isReady();
    mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    expect(document.body.querySelector('h1')?.textContent).toContain('Kinds');
    expect(document.body.querySelector('[data-testid="context-key"]')?.textContent).toContain('authoring.kinds');
    expect(document.body.querySelector('[data-testid="context-facts"]')?.textContent).toContain('Agents');
    const choice = document.body.querySelector<HTMLAnchorElement>('[data-testid="context-choices"] a');
    expect(choice?.textContent).toContain('The person asks how to read files');
    expect(choice?.getAttribute('href')).toBe('/context/fs/guide');
  });
});

describe('the models list', () => {
  it('marks the hub roles each model fills, the way systems see them', () => {
    const chat = model();
    const roles = ModelRoleView.array().parse([
      { role: 'chat', from: 'setting', resolved: { provider: chat.provider, model: chat.id } },
      { role: 'describe', from: 'env', resolved: { provider: chat.provider, model: chat.id } },
      { role: 'transcribe', from: 'none', resolved: { problem: 'No model hears audio' } },
    ]);
    const filled = rolesByModel(roles);
    expect(filled.get(modelKey(chat))).toEqual(['chat', 'describe']);
    const table = mount(ModelTable, { props: { models: [chat, model({ id: 'other', name: 'Other' })], providerName: () => 'OpenRouter', roles: filled } });
    const rows = table.findAll('[data-testid="model-row"]');
    expect(rows.find((row) => row.text().includes('GPT OSS'))?.findAll('[data-testid="model-role"]').map((badge) => badge.text())).toEqual(['Chat role', 'Image descriptions role']);
    expect(rows.find((row) => row.text().includes('Other'))?.findAll('[data-testid="model-role"]')).toHaveLength(0);
  });
});
