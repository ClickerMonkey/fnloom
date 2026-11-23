/** Injected context as an admin reads it: the words, total and order moves of the Injected tab, and its store. */
import { QualifiedName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { InjectedStore } from '../state/injected.ts';
import { fakeAdminApi, fakeInjections } from '../test/fakes.ts';
import { fakeCaller } from '../../test/fakes.ts';
import { byAgent, fnTabs, injectedTotal, injectionState, movedOrder, parseOrder, totalLine, viaWords } from './injected.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);
const chat = (): ReturnType<typeof fakeInjections> => fakeInjections().filter((view) => view.agent === 'hub/chat');

describe('the Injected tab\'s logic', () => {
  it('gives an agent an Injected tab with its count, and any other fn none', () => {
    expect(fnTabs(false).map((tab) => tab.value)).toEqual(['about']);
    expect(fnTabs(true, 4)).toEqual([{ value: 'about', label: 'About', icon: 'info' }, { value: 'injected', label: 'Injected', icon: 'layers', count: 4 }]);
    expect(fnTabs(true)[1]).not.toHaveProperty('count');
  });

  it('says each item\'s state, and totals what is in', () => {
    const [memory, , deals] = chat();
    expect(memory && injectionState(memory)).toEqual({ label: 'In', tone: 'ok', in: true });
    expect(deals && injectionState(deals)).toEqual({ label: 'Waiting for review', tone: 'warn', in: false });
    expect(injectionState({ detail: 'summary' })).toMatchObject({ label: 'In, as its summary', in: true });
    expect(injectionState({ detail: 'full', leftOut: { why: 'off', reason: '' } }).tone).toBe('neutral');
    expect(injectionState({ detail: 'full', leftOut: { why: 'declined', reason: '' } }).tone).toBe('danger');
    // replaced by another item that says what is true instead: expected, not a warning
    expect(injectionState({ detail: 'full', leftOut: { why: 'replaced', reason: 'replaced by Timers (timer/basics)' } })).toEqual({ label: 'Replaced', tone: 'neutral', in: false });
    const total = injectedTotal(chat());
    expect(total).toEqual({ in: 3, of: 4, tokens: 270 });
    expect(totalLine(total)).toBe('3 of 4 items in · about 270 tokens');
    expect(totalLine({ in: 0, of: 0, tokens: 0 })).toBe('Nothing is injected into this agent.');
  });

  it('says which target took an item in', () => {
    const [memory, , , hook] = chat();
    expect(memory && viaWords(memory)).toBe('Matched by hub/chat*');
    expect(hook && viaWords(hook)).toBe('Named directly');
  });

  it('reads a typed order, and moves an item one place past its neighbour', () => {
    expect(parseOrder(' 40 ')).toBe(40);
    expect(parseOrder('1001')).toBeUndefined();
    expect(parseOrder('-1')).toBeUndefined();
    expect(parseOrder('4.5')).toBeUndefined();
    const views = [{ order: 0 }, { order: 40 }, { order: 100 }];
    expect(movedOrder(views, 2, -1)).toBe(39);
    expect(movedOrder(views, 1, 1)).toBe(101);
    expect(movedOrder(views, 0, -1)).toBeUndefined();
    expect(movedOrder(views, 2, 1)).toBeUndefined();
    expect(movedOrder(views, 1, -1)).toBeUndefined();
  });

  it('lists one item\'s views by agent', () => {
    expect(byAgent(fakeInjections().filter((view) => view.context === 'input/asking')).map((row) => row.agent)).toEqual(['hub/chat', 'hub/chat_small']);
  });
});

describe('the injected store', () => {
  it('loads one agent\'s items, switches one off and reads the list again', async () => {
    const api = fakeAdminApi();
    const store = new InjectedStore(api);
    await store.open({ agent: q('hub/chat') });
    expect(store.page.value.value?.injections).toHaveLength(4);
    const [memory] = store.page.value.value?.injections ?? [];
    if (memory === undefined) { throw new Error('no item'); }
    expect(await store.switchOn(memory, false)).toBe(true);
    expect(api.setInjection.calls.at(-1)?.[0]).toEqual({ agent: 'hub/chat', context: 'hub/memory', on: false });
    expect(api.injections.calls).toHaveLength(2);
    expect(store.busyKey.value).toBe('');
  });

  it('shows a switch at once and puts it back when the hub refuses', async () => {
    const api = { ...fakeAdminApi(), setInjection: fakeCaller<'setInjection'>(() => Promise.reject(new Error('no'))) };
    const store = new InjectedStore(api);
    await store.open({ context: q('input/asking') });
    expect(store.page.value.value?.targets).toEqual([{ target: 'hub/chat*', agents: ['hub/chat', 'hub/chat_small'] }]);
    const [first] = store.page.value.value?.injections ?? [];
    if (first === undefined) { throw new Error('no item'); }
    expect(await store.reorder(first, 5)).toBe(false);
    expect(store.page.value.value?.injections[0]?.order).toBe(40);
    expect(store.saving.problem.value).not.toBe('');
  });
});
