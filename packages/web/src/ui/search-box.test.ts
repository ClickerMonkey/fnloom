import { LIST_FIELDS, type Sort } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { h, ref } from 'vue';
import UiSearch from './UiSearch.vue';
import UiSort from './UiSort.vue';
import type { SearchQuery } from './search.ts';

afterEach(() => { document.body.innerHTML = ''; });

const fields = LIST_FIELDS.runs.fields;

/** The box over a query held in a ref, as a page holds it. */
function box(start: SearchQuery = {}) {
  const query = ref<SearchQuery>(start);
  const values = (field: string) => Promise.resolve(field === 'fn' ? [{ value: 'fs/read', count: 4 }] : []);
  const host = mount(() => h(UiSearch, { fields, label: 'Search runs', delay: 0, values, modelValue: query.value, 'onUpdate:modelValue': (next: SearchQuery) => { query.value = next; } }), { attachTo: document.body });
  return { host, query, input: () => host.get<HTMLInputElement>('[data-testid="search-input"]') };
}

const pills = (): string[] => Array.from(document.querySelectorAll('[data-testid="search-pill"]')).map((p) => p.textContent.trim());

describe('UiSearch', () => {
  it('turns a typed filter into a pill at the space, and takes the last off with Backspace', async () => {
    const { query, input } = box();
    await input().setValue('status:failed ');
    await flushPromises();
    expect(query.value.filters).toEqual([{ field: 'status', op: 'is', value: 'failed' }]);
    expect(pills()).toEqual(['Status: Failed']);
    expect(input().element.value).toBe('');
    await input().trigger('keydown', { key: 'Backspace' });
    expect(query.value.filters).toBeUndefined();
  });

  it('suggests values as you type, from the declaration and the data, and adds the one chosen', async () => {
    const { query, input } = box();
    await input().trigger('focus');
    await input().setValue('read');
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    await flushPromises();
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options.map((o) => o.querySelector('.s-label')?.textContent)).toEqual(['Fn: fs/read', 'Search “read”']);
    options[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(query.value).toEqual({ filters: [{ field: 'fn', op: 'is', value: 'fs/read' }] });
  });

  it('searches plain words on Enter', async () => {
    const { query, input } = box();
    await input().setValue('deploy logs');
    await input().trigger('keydown', { key: 'Enter' });
    expect(query.value.text).toBe('deploy logs');
  });

  it('adds a filter from the menu: field, operator, value', async () => {
    const { host, query } = box({ sort: [{ field: 'cost', dir: 'asc' }] });
    await host.get('[data-testid="search-filter"]').trigger('click');
    await flushPromises();
    document.querySelector<HTMLElement>('[data-field="cost"]')?.click();
    await flushPromises();
    document.querySelector<HTMLElement>('[data-op="gte"]')?.click();
    await flushPromises();
    const value = document.querySelector<HTMLInputElement>('[data-testid="filter-menu"] input[aria-label="Value"]');
    if (value === null) { throw new Error('no value box'); }
    value.value = '$0.5';
    value.dispatchEvent(new Event('input'));
    await flushPromises();
    document.querySelector<HTMLElement>('[data-testid="filter-apply"]')?.click();
    await flushPromises();
    expect(query.value).toEqual({ sort: [{ field: 'cost', dir: 'asc' }], filters: [{ field: 'cost', op: 'gte', value: 0.5 }] });
    expect(pills()).toEqual(['Cost ≥ 0.5']);
  });

  it('changes a pill in the menu it opens', async () => {
    const { host, query } = box({ filters: [{ field: 'status', op: 'is', value: 'failed' }] });
    await host.get('[data-testid="search-pill"] button').trigger('click');
    await flushPromises();
    document.querySelector<HTMLElement>('[data-op="isNot"]')?.click();
    await flushPromises();
    document.querySelector<HTMLElement>('[data-testid="filter-apply"]')?.click();
    await flushPromises();
    expect(query.value.filters).toEqual([{ field: 'status', op: 'isNot', value: 'failed' }]);
  });
});

describe('UiSort', () => {
  it('always says the sort, the default until one is chosen, and turns the current field round', async () => {
    const sort = ref<readonly Sort[] | undefined>(undefined);
    const host = mount(() => h(UiSort, { fields, defaultSort: LIST_FIELDS.runs.defaultSort, modelValue: sort.value, 'onUpdate:modelValue': (next: readonly Sort[] | undefined) => { sort.value = next; } }), { attachTo: document.body });
    expect(host.get('[data-testid="sort"]').text()).toBe('Started, newest first');
    await host.get('[data-testid="sort"]').trigger('click');
    await flushPromises();
    const started = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((i) => i.textContent.includes('Started'));
    started?.click();
    await flushPromises();
    expect(sort.value).toEqual([{ field: 'createdAt', dir: 'asc' }]);
    expect(host.get('[data-testid="sort"]').text()).toBe('Started, oldest first');
  });
});
