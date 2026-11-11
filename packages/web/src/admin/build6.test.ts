/**
 * Build 6's admin side: an install's approval card on the runs page (what it binds: the system, its host, its hashes)
 * that approving clears, and a system hosted by another (fs) with its host, restart and stop.
 */
import { HostedBy } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { approval, run } from '../chat/test/fakes.ts';
import { STORES } from '../state/stores.ts';
import { fakeCaller, fakeStores } from '../test/fakes.ts';
import SystemOverview from './components/SystemOverview.vue';
import { hostText, systemActions } from './logic/systems.ts';
import { fakeAdmin, systemView } from './test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });

const SUBJECT = {
  kind: 'system-install', system: 'random', instance: 'main', version: '0.2.0', manifestHash: 'm'.repeat(64), bundleHash: 'b'.repeat(64), sourceHash: 's'.repeat(64),
  host: { system: 'fs', instance: 'main' }, replaces: { version: '0.1.0', manifestHash: 'o'.repeat(64) },
} as const;
const HOSTED = HostedBy.parse({ host: { system: 'fs', instance: 'main' }, path: 'systems/random', bundleHash: 'b'.repeat(64), approval: 'apr_install' });

describe('the runs page', () => {
  it('shows a waiting install with its words, what it binds and the scan, and approving it clears the card', async () => {
    const waiting = approval({
      id: 'apr_install', run: 'run_install', fn: 'fs/install_system',
      preview: {
        title: 'Update random 0.1.0 → 0.2.0', irreversible: false, subject: SUBJECT,
        parts: [{ type: 'code', language: 'text', code: 'child_process imported', title: 'Scan' }, { type: 'text', text: 'Adds **random/roll** (read).' }],
      },
    });
    const admin = fakeAdmin({
      chat: {
        run: fakeCaller<'run'>(({ run: id }) => Promise.resolve(run({ id, fn: 'fs/install_system', status: 'awaiting-approval' }))),
        approvals: fakeCaller<'approvals'>(() => Promise.resolve([waiting])),
      },
    });
    const fakes = fakeStores({ signedIn: true, admin });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/admin/runs?run=run_install');
    await router.isReady();
    mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();

    const card = document.body.querySelector('[data-testid="approval-card"]');
    expect(card).not.toBeNull();
    const subject = card?.querySelector('[data-testid="install-subject"]');
    expect(subject?.textContent).toContain('random');
    expect(subject?.textContent).toContain('replacing 0.1.0');
    expect(subject?.textContent).toContain('fs/main');
    expect(subject?.querySelector('code')?.getAttribute('title')).toBe(SUBJECT.bundleHash);
    // the words first, then what it binds, then the scan's code
    const order = [...(card?.querySelectorAll('[data-testid="install-subject"], .ui-code, .text') ?? [])].map((el) => (el.getAttribute('data-testid') === 'install-subject' ? 'subject' : el.classList.contains('text') ? 'text' : 'code'));
    expect(order).toEqual(['text', 'subject', 'code']);

    document.body.querySelector<HTMLButtonElement>('[data-testid="approve"]')?.click();
    await flushPromises();
    expect(admin.chatApi.approve.calls.map(([body]) => body)).toEqual([{ approval: 'apr_install', approve: true, remember: 'once' }]);
    expect(document.body.querySelector('[data-testid="approval-card"]')).toBeNull();
  });
});

describe('a hosted system', () => {
  it('says who hosts it and where, and restarts and stops through its host', async () => {
    const view = systemView({ name: 'random', host: HOSTED });
    expect(hostText(HOSTED)).toBe('fs/main at systems/random');
    expect([...systemActions(view)]).toEqual(['stop', 'restart', 'reimport', 'remove']);
    expect([...systemActions({ ...view, status: 'disconnected' })]).toEqual(['start', 'remove']);
    const overview = mount(SystemOverview, { props: { system: view, now: 0, nameOf: () => 'Ada' }, global: { stubs: { AccessControl: true } } });
    const card = overview.get('[data-testid="system-host"]');
    expect(card.text()).toContain('By fs/main at systems/random');
    await card.get('[data-testid="host-restart"]').trigger('click');
    await card.get('[data-testid="host-stop"]').trigger('click');
    expect(overview.emitted('act')).toEqual([['restart'], ['stop']]);
    await flushPromises();
  });
});
