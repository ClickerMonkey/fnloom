import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { h } from 'vue';
import { SystemName } from '@harness/core';
import { fakeChat, fakeChatApi } from '../../chat/test/fakes.ts';
import { fakeStores } from '../../test/fakes.ts';
import { fakePickerApi } from '../../test/pickers.ts';
import { STORES } from '../../state/stores.ts';
import AccessControl from './AccessControl.vue';
import HubPicker from '../pickers/HubPicker.vue';

afterEach(() => { document.body.innerHTML = ''; });

/** Mount `render` with stores whose hub has one person or several. */
function withHub(multiUser: boolean, render: () => ReturnType<typeof h>) {
  const api = { ...fakeChatApi(), ...fakePickerApi(multiUser) };
  const { chat } = fakeChat({ api });
  const stores = { ...fakeStores().stores, chat };
  mount(render, { attachTo: document.body, global: { provide: { [STORES]: stores } } });
  return api;
}

const target = { kind: 'system', system: SystemName.parse('fs') } as const;

describe('AccessControl', () => {
  it('shows nothing on a hub with one person', async () => {
    withHub(false, () => h(AccessControl, { target }));
    await flushPromises();
    expect(document.querySelector('[data-testid="access-control"]')).toBeNull();
  });

  it('shows the visibility on a hub with several and saves a change', async () => {
    const api = withHub(true, () => h(AccessControl, { target }));
    await flushPromises();
    expect(document.querySelector('[data-testid="access-control"]')).not.toBeNull();
    const only = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="visibility-choice"] button')).find((b) => b.textContent.includes('Only me'));
    only?.click();
    await flushPromises();
    expect(api.setAccess.calls).toEqual([[{ target, sharing: { visibility: 'private', with: [] } }]]);
  });
});

describe('HubPicker', () => {
  it('asks the hub for the source it names', async () => {
    const api = withHub(false, () => h(HubPicker, { source: 'system', label: 'Systems', modelValue: [] }));
    const input = document.querySelector<HTMLInputElement>('[data-testid="picker-input"]');
    input?.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    await flushPromises();
    expect(api.pick.calls[0]?.[0]).toEqual({ source: 'system', limit: 12 });
    expect(Array.from(document.querySelectorAll('[data-testid="picker-option"]')).map((o) => o.textContent.trim())).toEqual(['fs', 'web', 'claude']);
  });
});
