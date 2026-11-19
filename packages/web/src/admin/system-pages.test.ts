/**
 * The system pages (plan items 18 and 19): the Fns tab's master switch turns all of a system's fns off as the Context
 * tab's does its context; a system that runs one instance has no Instances tab but its instance's Data on its own page,
 * and its instance's old page sends there; a fleet keeps its Instances tab even with one instance.
 */
import { InstanceName, MAIN_INSTANCE } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { STORES } from '../state/stores.ts';
import { fakeCaller, fakeStores } from '../test/fakes.ts';
import { fakeAdmin, systemCounts, systemView } from './test/fakes.ts';
import type { InstanceView } from '@harness/core';

afterEach(() => { document.body.innerHTML = ''; });

/** The one instance of a single-instance system, run by the hub with its folders. */
const MAIN: InstanceView = {
  system: systemView().name, instance: MAIN_INSTANCE, description: '', status: 'connected', keyFingerprint: 'SHA256:9f2c', version: '0.4.0', manifestHash: 'h',
  dirs: { data: '/hub/code/data', state: '/hub/code/state', cache: '/hub/code/cache' },
};

/** The app on a page, with the system the hub answers. */
async function open(path: string, mode: 'one' | 'many', instances: readonly InstanceView[] = [MAIN]): Promise<{ router: Router; admin: ReturnType<typeof fakeAdmin> }> {
  const admin = fakeAdmin();
  admin.api.system = fakeCaller<'system'>(({ system }) => Promise.resolve(systemView({ name: system, instanceMode: mode, instances, counts: systemCounts({ fns: 2, instances: instances.length }) })));
  admin.api.instances = fakeCaller<'instances'>(() => Promise.resolve([...instances]));
  const fakes = fakeStores({ signedIn: true, admin });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { router, admin };
}

const tabLabels = (): string[] => [...document.body.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.replace(/\d+/g, '').trim());
const query = (selector: string): HTMLElement | null => document.body.querySelector<HTMLElement>(selector);

describe('the Fns tab', () => {
  it('has a master switch that turns all of its fns off, saying mentions and hooks go with them', async () => {
    const { admin } = await open('/admin/systems/fs/fns', 'many');
    const all = query('[data-testid="system-fns-all"]');
    expect(all?.textContent).toContain('mentions and hooks');
    all?.querySelector('button')?.click();
    await flushPromises();
    expect(admin.api.enableSystem.calls.map(([body]) => body)).toEqual([{ system: 'fs', functions: false }]);
    // each fn keeps its own switch underneath
    expect(document.body.querySelectorAll('[data-testid="system-fns-all"]')).toHaveLength(1);
    expect(query('[data-testid="system-context-all"]')).toBeNull();
  });
});

describe('a system that runs one instance', () => {
  it('has no Instances tab, but its instance’s data on its own page', async () => {
    const { router } = await open('/admin/systems/fs', 'one');
    expect(tabLabels()).not.toContain('Instances');
    expect(tabLabels()).toContain('Data');
    expect(query('[data-testid="system-facts"]')?.textContent).toContain('SHA256:9f2c41a0b7');
    await router.push('/admin/systems/fs/data');
    await flushPromises();
    expect(query('[data-testid="instance-data"]')?.textContent).toContain('/hub/code/data');
    // the Instances tab it doesn't have reads as its overview
    await router.push('/admin/systems/fs/instances');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/admin/systems/fs');
  });

  it('exports its main instance’s data from its Data tab', async () => {
    const { admin } = await open('/admin/systems/fs/data', 'one');
    query('[data-testid="export-data"]')?.click();
    await flushPromises();
    expect(admin.api.exportSystemData.calls.map(([body]) => body)).toEqual([{ system: 'fs', instance: MAIN_INSTANCE }]);
    expect(query('[data-testid="export-download"]')).not.toBeNull();
  });

  it('sends its instance’s old page to the same tab of the system’s page', async () => {
    const { router } = await open('/admin/systems/fs/instances/main/config', 'one');
    expect(router.currentRoute.value.fullPath).toBe('/admin/systems/fs/config');
  });
});

describe('a fleet', () => {
  it('keeps its Instances tab and instance pages even with one instance, and has no Data tab', async () => {
    const { router } = await open('/admin/systems/fs', 'many');
    expect(tabLabels()).toContain('Instances');
    expect(tabLabels()).not.toContain('Data');
    await router.push('/admin/systems/fs/instances/main/data');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/admin/systems/fs/instances/main/data');
    expect(query('[data-testid="instance-data"]')).not.toBeNull();
    await router.push(`/admin/systems/fs/instances/${InstanceName.parse('main')}`);
    await flushPromises();
    expect(query('[data-testid="instance-facts"]')?.textContent).toContain('SHA256:9f2c');
  });

  it('opened straight at a Data tab it doesn’t have, reads as its overview', async () => {
    // regression: the tab guard watched only the computed `single`, which never changes for a fleet
    const { router } = await open('/admin/systems/fs/data', 'many');
    expect(router.currentRoute.value.fullPath).toBe('/admin/systems/fs');
    expect(query('[data-testid="instance-data"]')).toBeNull();
  });
});
