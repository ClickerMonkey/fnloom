import { FnMatch, McpSelector } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { setFnCondition } from '../logic/mcps.ts';
import FnConditionDialog from './FnConditionDialog.vue';
import McpSelectorEditor from './McpSelectorEditor.vue';

afterEach(() => { document.body.innerHTML = ''; });

const click = async (selector: string): Promise<void> => {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (el === null) { throw new Error(`no ${selector}`); }
  el.click();
  await flushPromises();
};

describe('fn rule conditions', () => {
  it('sets and removes the condition of one fn rule, leaving the others', () => {
    const selector = McpSelector.parse({ fns: [{ fn: 'fs/*' }, { fn: 'fs/read', when: { kind: 'new', type: { name: 'bool' }, value: true } }] });
    expect(setFnCondition(selector, 0, { kind: 'get', path: [{ prop: 'args' }] }).fns).toEqual([
      { fn: 'fs/*', when: { kind: 'get', path: [{ prop: 'args' }] } }, selector.fns?.[1],
    ]);
    expect(setFnCondition(selector, 1, undefined).fns).toEqual([{ fn: 'fs/*' }, { fn: 'fs/read' }]);
  });

  it('starts a condition in gin’s expression editor and saves it as JSON', async () => {
    const dialog = mount(FnConditionDialog, { attachTo: document.body, props: { open: false, match: FnMatch.parse({ fn: 'fs/*' }), title: 'Condition for fs/*' } });
    await dialog.setProps({ open: true });
    expect(document.body.querySelector('[data-testid=fn-condition-expr]')).toBeNull();
    await click('[data-testid=fn-condition-start]');
    expect(document.body.querySelector('[data-testid=fn-condition-expr]')).not.toBeNull();
    await click('[data-testid=fn-condition-save]');
    expect(dialog.emitted('save')?.[0]?.[0]).toMatchObject({ kind: 'new', value: true });
    dialog.unmount();
  });

  it('opens an existing condition, and Remove drops it', async () => {
    const when = { kind: 'new', type: { name: 'bool' }, value: false };
    const dialog = mount(FnConditionDialog, { attachTo: document.body, props: { open: false, match: FnMatch.parse({ fn: 'fs/read', when }), title: 'Condition' } });
    await dialog.setProps({ open: true });
    expect(document.body.querySelector('[data-testid=fn-condition-expr]')).not.toBeNull();
    await click('[data-testid=fn-condition-remove]');
    await click('[data-testid=fn-condition-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([undefined]);
    dialog.unmount();
  });

  it('opens a fn chip’s condition from the rules editor and emits the changed rules', async () => {
    const selector = McpSelector.parse({ fns: [{ fn: 'fs/*' }] });
    const editor = mount(McpSelectorEditor, { attachTo: document.body, props: { title: 'Include', about: '', selector, testid: 'inc' } });
    expect(editor.text()).toContain('fs/*');
    await click('[data-testid=inc-fns-when-0]');
    await click('[data-testid=fn-condition-start]');
    await click('[data-testid=fn-condition-save]');
    const changed = editor.emitted('change')?.[0]?.[0];
    expect(McpSelector.parse(changed).fns?.[0]).toMatchObject({ fn: 'fs/*', when: { kind: 'new', value: true } });
    editor.unmount();
  });
});
