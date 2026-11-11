/** The `install_system` card: waiting for an admin, then what started (connected or waiting for config) and its page. */
import { mintId } from '@harness/core';
import type { FnViewOf } from '@harness/sdk';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { fs } from '../shared/index.ts';
import { fakeFsSystem } from './fakes.ts';
import InstallView from './InstallView.vue';

type InstallProps = FnViewOf<typeof fs, 'install_system'>;

const props = (overrides: Partial<InstallProps>): InstallProps => ({
  run: mintId('run'), status: 'awaiting-approval', args: { path: 'systems/random' }, state: {}, submit: undefined, system: fakeFsSystem().system, ...overrides,
});

describe('InstallView', () => {
  it('says it waits for an admin, then what started, its fns and a link to its page', async () => {
    const card = mount(InstallView, { props: props({}) });
    expect(card.find('.chip').text()).toBe('Waiting for an admin');
    expect(card.find('.what').text()).toBe('Install systems/random');
    await card.setProps({ status: 'done', result: { system: 'random', instance: 'main', version: '0.1.0', status: 'connected', fns: ['random/roll', 'random/pick'], folder: 'C:/work/systems/random' } });
    expect(card.find('.chip').text()).toBe('Connected');
    expect(card.find('.what').text()).toBe('random 0.1.0');
    expect(card.findAll('.fns li').map((li) => li.text())).toEqual(['roll', 'pick']);
    expect(card.get('[data-testid="install-open"]').attributes('href')).toBe('/admin/systems/random');
    expect(card.find('.hint').exists()).toBe(false);
  });

  it('asks for config when the system waits for it, and links an instance to its own page', () => {
    const card = mount(InstallView, { props: props({ status: 'done', args: { path: 'systems/notes', instance: 'laptop' }, result: { system: 'notes', instance: 'laptop', version: '1.0.0', status: 'needs-config', fns: [], folder: '/srv/notes' } }) });
    expect(card.find('.chip').text()).toBe('Needs its config');
    expect(card.find('.hint').exists()).toBe(true);
    expect(card.get('[data-testid="install-open"]').attributes('href')).toBe('/admin/systems/notes/instances/laptop');
  });

  it('says why an install failed', () => {
    const card = mount(InstallView, { props: props({ status: 'failed', error: { class: 'fatal', code: 'failed', message: 'the hub refused the pairing grant' } }) });
    expect(card.find('.chip').text()).toBe('Not installed');
    expect(card.find('.problem').text()).toBe('the hub refused the pairing grant');
  });
});
