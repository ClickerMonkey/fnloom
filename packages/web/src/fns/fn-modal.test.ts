/**
 * Build 9 feedback: a fn clicked on a system's page opens the fn modal over the page (no navigation), with everything
 * its page shows (overview, on/off switch, numbers, payload, access, history, latest runs) from the same `FnDetails`;
 * the modal's switch makes the same hub call as the page's, and the page still shows the same sections.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';

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

function find(selector: string, root: ParentNode = document.body): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (el === null) { throw new Error(`no ${selector}`); }
  return el;
}
const dialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="dialog"]');
/** The sections a fn's details show, by their test ids, in order of first appearance. */
function sections(root: HTMLElement): string[] {
  const ids = [...root.querySelectorAll<HTMLElement>('[data-testid]')].map((el) => el.dataset['testid'] ?? '');
  return [...new Set(ids)].filter((id) => ['fn-overview', 'fn-on', 'fn-facts', 'fn-uses', 'fn-stats', 'fn-metrics', 'fn-period', 'fn-recent', 'fn-runs'].includes(id));
}
const SECTIONS = ['fn-overview', 'fn-on', 'fn-facts', 'fn-uses', 'fn-stats', 'fn-period', 'fn-metrics', 'fn-recent', 'fn-runs'];

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { document.body.innerHTML = ''; });

describe('the fn modal on a system page', () => {
  it('opens over the fns tab without navigating, showing the fn page’s sections and numbers', async () => {
    const { app, router, admin } = await visit('/admin/systems/fs/fns');
    expect(dialog()).toBeNull();
    find('[data-testid="fn-page"]').click();
    await flushPromises();
    // the page stays; the fn is in its URL (`?fn=`), so the open modal is a link to share
    expect(router.currentRoute.value.path).toBe('/admin/systems/fs/fns');
    expect(router.currentRoute.value.query['fn']).toBe('fs/read_file');
    const open = dialog();
    expect(open).not.toBeNull();
    if (open === null) { return; }
    const details = find('[data-testid="fn-details"]', open);
    expect(open.textContent).toContain('Read file');
    expect(sections(details).sort()).toEqual([...SECTIONS].sort());
    // its numbers come from the fn page's own source: the fn's metrics and days, and its latest runs
    expect(admin.api.fnMetrics.calls.at(-1)?.[0]).toEqual({ fn: 'fs/read_file', days: 7 });
    expect(admin.api.fnMetricsDays.calls.at(-1)?.[0]).toEqual({ fn: 'fs/read_file', days: 7 });
    expect(find('[data-testid="fn-open-page"]', open)).toBeTruthy();
    app.unmount();
  });

  it('turns the fn off with the same hub call as the fn page, and the list follows', async () => {
    const { app, admin } = await visit('/admin/systems/fs/fns');
    find('[data-testid="fn-page"]').click();
    await flushPromises();
    const open = dialog();
    if (open === null) { throw new Error('no fn modal'); }
    const toggle = find('[data-testid="fn-on"] [role="switch"]', open);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click();
    await flushPromises();
    expect(admin.api.switchItem.calls.at(-1)?.[0]).toEqual({ section: 'fns', name: 'fs/read_file', on: false });
    expect(find('[data-testid="fn-on"] [role="switch"]', open).getAttribute('aria-checked')).toBe('false');
    // the system page's own row switch shows it off too
    expect(find('[data-testid="fn-switch"] [role="switch"]').getAttribute('aria-checked')).toBe('false');
    app.unmount();

    const page = await visit('/admin/systems/fs/fns/read_file');
    find('[data-testid="fn-on"] [role="switch"]').click();
    await flushPromises();
    expect(page.admin.api.switchItem.calls.at(-1)?.[0]).toEqual({ section: 'fns', name: 'fs/read_file', on: false });
    page.app.unmount();
  });

  it('closes with Close and Escape, and Open page goes to the full page', async () => {
    const { app, router } = await visit('/admin/systems/fs/fns');
    find('[data-testid="fn-page"]').click();
    await flushPromises();
    find('[role="dialog"] [aria-label="Close"]').click();
    await flushPromises();
    expect(dialog()).toBeNull();

    find('[data-testid="fn-page"]').click();
    await flushPromises();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(dialog()).toBeNull();

    find('[data-testid="fn-page"]').click();
    await flushPromises();
    find('[data-testid="fn-open-page"]').click();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/admin/systems/fs/fns/read_file');
    app.unmount();
  });
});

describe('the fn page', () => {
  it('shows the same sections as the fn modal, from the same details', async () => {
    const { app, router } = await visit('/admin/systems/fs/fns/read_file');
    expect(dialog()).toBeNull();
    const details = find('[data-testid="fn-details"]');
    expect(sections(details).sort()).toEqual([...SECTIONS].sort());
    expect(find('[data-testid="back-to-system"]').textContent).toContain('fs');
    // the period lives in the page's URL
    const period = [...find('[data-testid="fn-period"]').querySelectorAll<HTMLElement>('button, [role="radio"]')].find((el) => el.textContent.includes('30'));
    period?.click();
    await flushPromises();
    expect(router.currentRoute.value.query['days']).toBe('30');
    app.unmount();
  });
});
