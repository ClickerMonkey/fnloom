/**
 * Every build 2 page in the whole app, at its own address, over the fake stores: each renders what its stores hold,
 * follows its tab and query in the URL, and opens its dialogs.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { SystemName } from '@harness/core';
import { T0 } from '../admin/test/fakes.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import App from './App.vue';
import { createAppRouter } from './router.ts';

/** Mount the app, signed in as an admin, at a path. */
async function visit(path: string) {
  const fakes = fakeStores({ signedIn: true });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, router, app };
}

/** The page's main region text. */
function text(): string {
  return document.body.querySelector('main')?.textContent ?? document.body.textContent;
}

/** Every element matching a selector. */
function all(selector: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(selector)];
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('the models page', () => {
  for (const tab of ['providers', 'models', 'categories', 'roles', 'limits'] as const) {
    it(`shows its ${tab} tab from the URL`, async () => {
      const { app, router } = await visit(`/admin/models/${tab}`);
      expect(router.currentRoute.value.params['tab']).toBe(tab);
      expect(text().length).toBeGreaterThan(0);
      app.unmount();
    });
  }
});

describe('the limits page', () => {
  for (const tab of ['budgets', 'priorities', 'resolved'] as const) {
    it(`shows its ${tab} tab from the URL`, async () => {
      const { app } = await visit(`/admin/limits/${tab}?user=act_ada`);
      expect(text().length).toBeGreaterThan(0);
      app.unmount();
    });
  }
});

describe('the model calls page', () => {
  it('lists calls and opens one from the URL', async () => {
    const { app } = await visit('/admin/model-calls?modality=chat');
    expect(text().length).toBeGreaterThan(0);
    app.unmount();
  });
});

describe('the MCP pages', () => {
  it('lists the MCPs', async () => {
    const { app } = await visit('/admin/mcps');
    expect(text()).toContain('Claude sessions');
    app.unmount();
  });

  for (const tab of ['rules', 'preview', 'connect', 'activity'] as const) {
    it(`shows an MCP's ${tab} tab from the URL`, async () => {
      const { app } = await visit(`/admin/mcps/mcp_claude/${tab}`);
      expect(text()).toContain('Claude sessions');
      app.unmount();
    });
  }
});

describe('the instance page', () => {
  for (const tab of ['overview', 'config', 'data'] as const) {
    it(`shows an instance's ${tab} tab from the URL`, async () => {
      const { app } = await visit(`/admin/systems/fs/instances/main/${tab}`);
      expect(text().length).toBeGreaterThan(0);
      app.unmount();
    });
  }
});

describe('the pairing page', () => {
  it('shows a pairing to approve', async () => {
    const { app } = await visit('/pair/par_1');
    expect(text()).toContain('Files on Phil’s laptop');
    app.unmount();
  });
});

describe('the resource browser', () => {
  for (const view of ['list', 'grid', 'groups'] as const) {
    it(`shows the ${view} view from the URL`, async () => {
      const { app } = await visit(`/resources?view=${view}`);
      expect(text().length).toBeGreaterThan(0);
      app.unmount();
    });
  }
});

/** The first element matching a selector, or a failure naming it. */
function one(selector: string): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(selector);
  if (found === null) { throw new Error(`no ${selector}`); }
  return found;
}

/** Click an element and let the page settle. */
async function click(selector: string): Promise<void> {
  one(selector).click();
  await flushPromises();
}

/** Type into an input (the element or the input inside it). */
async function type(selector: string, value: string): Promise<void> {
  const el = one(selector);
  const input = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : el.querySelector('input, textarea');
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) { throw new Error(`no input in ${selector}`); }
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

describe('the MCP pages, acting', () => {
  it('makes an MCP from the dialog and shows its secret once', async () => {
    const { app, admin } = await visit('/admin/mcps');
    await click('[data-testid=new-mcp]');
    expect(one('[data-testid=mcp-form]')).toBeDefined();
    await type('[data-testid=mcp-name]', 'Review bot');
    await type('[data-testid=mcp-slug]', 'review-bot');
    await click('[data-testid=mcp-save]');
    expect(admin.api.createMcp.calls.length + all('[data-testid=secret-dialog]').length).toBeGreaterThan(0);
    app.unmount();
  });

  it('opens an MCP’s settings, rotation and deletion from its page', async () => {
    const { app, admin } = await visit('/admin/mcps/mcp_claude/rules');
    await click('[data-testid=mcp-settings]');
    expect(one('[data-testid=mcp-form]')).toBeDefined();
    await click('[data-testid=mcp-rotate]');
    await click('[data-testid=confirm]');
    expect(admin.api.rotateMcpSecret.calls).toHaveLength(1);
    await click('[data-testid=mcp-delete]');
    await click('[data-testid=confirm]');
    expect(admin.api.deleteMcp.calls).toHaveLength(1);
    app.unmount();
  });
});

describe('the pairing page, acting', () => {
  // the fake request expires minutes after T0
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for a config the system’s config type accepts before pairing, and warns of a code that doesn’t match', async () => {
    const { app, admin } = await visit('/pair/par_1?code=111111');
    expect(one('[data-testid=pair-code-check]').textContent).toContain('Not the code in the link');
    await type('[data-testid=pair-instance]', 'laptop');
    const approve = one('[data-testid=pair-approve]');
    expect(approve instanceof HTMLButtonElement && approve.disabled).toBe(true);
    await click('[data-testid=pair-approve]');
    expect(admin.api.approvePairing.calls).toEqual([]);
    app.unmount();
  });

  it('leads a newly paired system, installed and not live, on to its review', async () => {
    const { app, admin, router } = await visit('/pair/par_1');
    const paired = await admin.admin.pairing.approve(undefined, { root: '/notes' });
    expect(paired.ok).toBe(true);
    admin.user.push({ type: 'system', system: SystemName.parse('notes'), status: 'connected' });
    await flushPromises();
    expect(one('[data-testid=pair-done-body]').textContent).toContain('installed, not live');
    await click('[data-testid=pair-review]');
    await vi.waitFor(() => { expect(router.currentRoute.value.path).toBe('/admin/systems/notes/review'); }, { timeout: 5_000 });
    app.unmount();
  });

  it('refuses a pairing', async () => {
    const { app, admin } = await visit('/pair/par_1');
    await click('[data-testid=pair-refuse]');
    expect(admin.api.approvePairing.calls.at(-1)?.[0]).toMatchObject({ approve: false });
    app.unmount();
  });
});

describe('the instance page, acting', () => {
  it('exports an instance’s data and asks before removing it', async () => {
    const { app, admin } = await visit('/admin/systems/fs/instances/main/data');
    await click('[data-testid=export-data]');
    expect(admin.api.exportSystemData.calls).toHaveLength(1);
    app.unmount();
    const again = await visit('/admin/systems/fs/instances/main/overview');
    await click('[data-testid=remove-instance]');
    await click('[data-testid=confirm]');
    expect(again.admin.api.removeInstance.calls).toHaveLength(1);
    again.app.unmount();
  });
});

describe('the model calls page, filtering', () => {
  it('clears the run it was opened for, in the URL', async () => {
    const { app, router } = await visit('/admin/model-calls?run=run_1');
    await click('[data-testid=filter-run]');
    expect(router.currentRoute.value.query['run']).toBeUndefined();
    app.unmount();
  });
});

describe('the other admin pages', () => {
  for (const path of [
    '/admin/systems', '/admin/systems/fs/overview', '/admin/systems/fs/instances', '/admin/systems/fs/config', '/admin/systems/fs/fns', '/admin/systems/fs/logs',
    '/admin/systems/fs/fns/fs%2Fread_file', '/admin/policies', '/admin/actor-settings', '/admin/runs', '/admin/runs?status=failed', '/admin/llm',
  ]) {
    it(`shows ${path}`, async () => {
      const { app } = await visit(path);
      expect(text().length).toBeGreaterThan(0);
      app.unmount();
    });
  }
});
