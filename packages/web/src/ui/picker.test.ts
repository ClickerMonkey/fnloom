import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { h, ref } from 'vue';
import type { ShareRule } from '@harness/core';
import UiPicker from './UiPicker.vue';
import UiVisibility from './UiVisibility.vue';
import { listSource, onePicked, pickChoices, stepActive, withoutPicked, withPicked } from './picker.ts';

afterEach(() => { document.body.innerHTML = ''; });

const FNS = [{ value: 'fs/read', label: 'fs/read', hint: 'Read a file' }, { value: 'fs/search', label: 'fs/search' }, { value: 'hub/chat', label: 'hub/chat' }];
const wait = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 5); }); await flushPromises(); };

describe('picker rules', () => {
  it('leaves picked values out and offers the words as typed when custom reads them', () => {
    expect(pickChoices(FNS, ['fs/read'], '').map((c) => c.option.value)).toEqual(['fs/search', 'hub/chat']);
    const own = pickChoices(FNS, [], 'fs/*', (text) => text);
    expect(own.at(-1)).toEqual({ option: { value: 'fs/*', label: 'fs/*', hint: 'as typed' }, custom: true });
    expect(pickChoices(FNS, [], 'fs/read', (text) => text).filter((c) => c.custom)).toEqual([]);
  });

  it('picks, replaces in a single picker, respects max, removes and steps', () => {
    expect(withPicked(['a'], 'b', undefined)).toEqual(['a', 'b']);
    expect(withPicked(['a'], 'a', undefined)).toEqual(['a']);
    expect(withPicked(['a'], 'b', 1)).toEqual(['b']);
    expect(withPicked(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(withoutPicked(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(onePicked('')).toEqual([]);
    expect([stepActive(2, 3, 1), stepActive(0, 3, -1), stepActive(0, 0, 1)]).toEqual([0, 2, 0]);
  });

  it('labels values from a fixed list, missing when unknown', async () => {
    expect(await listSource(FNS).label(['fs/read', 'gone/fn'])).toEqual([FNS[0], { value: 'gone/fn', label: 'gone/fn', missing: true }]);
    expect((await listSource(FNS).search('READ')).map((o) => o.value)).toEqual(['fs/read']);
  });
});

/** A picker over a value held in a ref, as a form holds it. */
function picker(start: readonly string[], props: Record<string, unknown> = {}) {
  const values = ref<readonly string[]>(start);
  const host = mount(() => h(UiPicker, {
    source: listSource(FNS), label: 'Fns', delay: 0, ...props, modelValue: values.value, 'onUpdate:modelValue': (next: readonly string[]) => { values.value = next; },
  }), { attachTo: document.body });
  const input = () => host.get<HTMLInputElement>('[data-testid="picker-input"]');
  const options = (): string[] => Array.from(document.querySelectorAll('[data-testid="picker-option"]')).map((o) => o.textContent.trim());
  const chips = (): string[] => Array.from(document.querySelectorAll('[data-testid="picker-chip"]')).map((c) => c.textContent.trim());
  return { host, values, input, options, chips };
}

describe('UiPicker', () => {
  it('searches as you type, picks with arrows and Enter, and removes the last chip with Backspace', async () => {
    const { values, input, options, chips } = picker([]);
    await input().trigger('focus');
    await input().setValue('fs');
    await wait();
    expect(options()).toEqual(['fs/readRead a file', 'fs/search']);
    await input().trigger('keydown', { key: 'ArrowDown' });
    await input().trigger('keydown', { key: 'Enter' });
    expect(values.value).toEqual(['fs/search']);
    expect(chips()).toEqual(['fs/search']);
    expect(input().element.value).toBe('');
    await input().trigger('keydown', { key: 'Backspace' });
    expect(values.value).toEqual([]);
  });

  it('labels the chips it starts with, marks a missing one, and Esc closes the list', async () => {
    const { input, chips, options } = picker(['fs/read', 'gone/fn']);
    await wait();
    expect(chips()).toEqual(['fs/read', 'gone/fn']);
    expect(document.querySelector('[data-testid="picker-chip"].missing')?.textContent).toContain('gone/fn');
    await input().trigger('focus');
    await wait();
    expect(options()).toEqual(['fs/search', 'hub/chat']);
    await input().trigger('keydown', { key: 'Escape' });
    expect(options()).toEqual([]);
  });

  it('a single picker replaces its value, and custom takes the words as typed', async () => {
    const { values, input } = picker(['fs/read'], { max: 1, custom: (text: string) => (text.includes('*') ? text : undefined) });
    await input().trigger('focus');
    await input().setValue('fs/*');
    await wait();
    await input().trigger('keydown', { key: 'Enter' });
    expect(values.value).toEqual(['fs/*']);
  });
});

describe('UiVisibility', () => {
  it('switches visibility and picks people when shared', async () => {
    const rule = ref<ShareRule>({ visibility: 'public', with: [] });
    const people = listSource([{ value: 'act_ann', label: 'Ann' }]);
    mount(() => h(UiVisibility, { people, modelValue: rule.value, 'onUpdate:modelValue': (next: ShareRule) => { rule.value = next; } }), { attachTo: document.body });
    expect(document.querySelector('[data-testid="visibility-people"]')).toBeNull();
    const shared = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="visibility-choice"] button')).find((b) => b.textContent.includes('chosen'));
    shared?.click();
    await flushPromises();
    expect(rule.value.visibility).toBe('shared');
    expect(document.querySelector('[data-testid="visibility-people"]')).not.toBeNull();
  });
});
