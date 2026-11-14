/**
 * The expression editor's model over every node kind and every slot, list and field: an edit of a slot a node has
 * changes that slot only and gives a definition gin still parses; a slot, list or field the node doesn't have leaves
 * the definition as it was; an optional slot empties and a required one never does; and what can be taken out is
 * taken out of the right list.
 */
import type { ExprDef } from '@aeye/gin';
import { g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import {
  childrenOf, EXPR_KINDS, ExprTools, exprLabel, marksWithin, pathOf, problemsAt, removalOf, viewOf, withChild, withList, withScalar,
  type ExprList, type ExprSlot, type ExprView, type ListEdit, type ScalarEdit,
} from './expr.ts';

const tools = new ExprTools(g);
const text = (value: string): ExprDef => ({ kind: 'new', type: { name: 'text' }, value });
const yes: ExprDef = { kind: 'new', type: { name: 'bool' }, value: true };
const read = (name: string): ExprDef => ({ kind: 'get', path: [{ prop: name }] });

function view(def: ExprDef): ExprView {
  const parsed = tools.parse(def);
  if (!parsed.ok) { throw new Error(`gin refused ${JSON.stringify(def)}: ${parsed.problem}`); }
  return viewOf(parsed.value);
}

/** One node of each kind, with every slot it can hold filled (two branches, two cases, a call and an index step). */
const NODES = {
  new: text('hi'),
  get: { kind: 'get', path: [{ prop: 'value' }, { prop: 'pick' }, { args: { arg: text('a'), other: text('b') } }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }] },
  set: { kind: 'set', path: [{ prop: 'value' }, { key: { kind: 'new', type: { name: 'num' }, value: 1 } }], value: text('x') },
  define: { kind: 'define', vars: [{ name: 'x', value: text('a') }, { name: 'y', value: text('b') }], body: read('x') },
  block: { kind: 'block', lines: [text('one'), text('two')] },
  if: { kind: 'if', ifs: [{ condition: yes, body: text('a') }, { condition: yes, body: text('b') }], else: text('c') },
  switch: { kind: 'switch', value: read('value'), cases: [{ equals: [text('a'), text('b')], body: text('first') }, { equals: [text('c')], body: text('second') }], else: text('other') },
  loop: { kind: 'loop', over: read('value'), key: 'i', value: 'item', body: { kind: 'block', lines: [] } },
  lambda: tools.blank('lambda'),
  template: { kind: 'template', template: 'Hello {name}', params: { kind: 'new', type: { name: 'obj', props: { name: { type: { name: 'text' } } } }, value: { name: 'Ada' } } },
  return: { kind: 'flow', action: 'return', value: text('done') },
  throw: { kind: 'flow', action: 'throw', error: text('bad') },
  break: { kind: 'flow', action: 'break' },
  native: { kind: 'native', id: 'text.upper' },
} satisfies Record<string, ExprDef>;

const SLOTS: ExprSlot[] = [
  { at: 'set.value' }, { at: 'define.body' }, { at: 'if.else' }, { at: 'switch.value' }, { at: 'switch.else' }, { at: 'loop.over' }, { at: 'loop.body' },
  { at: 'lambda.body' }, { at: 'lambda.constraint' }, { at: 'template.params' }, { at: 'flow.value' }, { at: 'flow.error' },
  { at: 'define.var', index: 1 }, { at: 'block.line', index: 1 }, { at: 'if.condition', index: 1 }, { at: 'if.body', index: 1 }, { at: 'switch.body', index: 1 },
  { at: 'switch.equals', index: 0, item: 1 }, { at: 'step.arg', step: 2, name: 'other' }, { at: 'step.key', step: 3 }, { at: 'step.key', step: 1 },
];

const LISTS: ExprList[] = [{ of: 'steps' }, { of: 'lines' }, { of: 'branches' }, { of: 'cases' }, { of: 'vars' }, { of: 'equals', index: 0 }, { of: 'args', step: 2 }];
const EDITS: ListEdit[] = [{ op: 'add' }, { op: 'add', step: 'call' }, { op: 'add', step: 'key' }, { op: 'remove', index: 0 }, { op: 'move', index: 0, by: 1 }, { op: 'move', index: 9, by: -1 }];

const SCALARS: ScalarEdit[] = [
  { field: 'comment', text: 'why' }, { field: 'comment', text: '' }, { field: 'prop', step: 0, name: 'other' }, { field: 'arg', step: 2, from: 'arg', to: 'first' },
  { field: 'var', index: 0, name: 'z' }, { field: 'loop-key', name: 'n' }, { field: 'loop-key', name: '' }, { field: 'loop-value', name: 'row' }, { field: 'loop-value', name: '' },
  { field: 'template', text: 'Bye {name}' }, { field: 'action', action: 'break' }, { field: 'native', id: 'text.lower' },
  { field: 'new-type', type: { name: 'num' } }, { field: 'new-value', value: 'there' },
];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe('the expression model', () => {
  it('reads every kind by gin\'s classes, labels it, and gives a blank of each kind that gin parses', () => {
    for (const [name, def] of Object.entries(NODES)) { expect(view(def).kind, name).toBe(def.kind); }
    for (const { kind, label } of EXPR_KINDS) {
      expect(view(tools.blank(kind, 'x')).kind).toBe(kind);
      expect(exprLabel(kind)).toBe(label);
    }
    expect(exprLabel('other')).toBe('Expression');
    expect(pathOf([{ kind: 'prop', name: 'a' }, { kind: 'call', args: [['x', text('1')]] }, { kind: 'key', key: text('k') }])).toEqual([{ prop: 'a' }, { args: { x: text('1') } }, { key: text('k') }]);
  });

  it('sets a slot a node has to the new definition only, and leaves a node without that slot as it was', () => {
    const replacement = text('new');
    for (const [name, def] of Object.entries(NODES)) {
      const node = view(def);
      const children = childrenOf(node);
      for (const slot of SLOTS) {
        const next = withChild(node, slot, replacement);
        const had = children.find((c) => same(c.slot, slot));
        if (had === undefined) {
          expect(next, `${name} ${slot.at}`).toEqual(node.def);
          continue;
        }
        const after = childrenOf(view(next)).find((c) => same(c.slot, slot));
        expect(after?.def, `${name} ${slot.at}`).toEqual(replacement);
        // every other child is as it was
        expect(childrenOf(view(next)).filter((c) => !same(c.slot, slot)).map((c) => c.def), `${name} ${slot.at}`).toEqual(children.filter((c) => !same(c.slot, slot)).map((c) => c.def));
      }
    }
  });

  it('empties an optional slot and never a required one; says how each child is taken out', () => {
    for (const [name, def] of Object.entries(NODES)) {
      const node = view(def);
      for (const item of childrenOf(node)) {
        const emptied = withChild(node, item.slot, undefined);
        if (item.optional) {
          expect(childrenOf(view(emptied)).find((c) => same(c.slot, item.slot))?.def, `${name} ${item.slot.at}`).toBeUndefined();
          expect(removalOf(node, item)).toEqual({ by: 'empty' });
          continue;
        }
        expect(emptied, `${name} ${item.slot.at}`).toEqual(node.def);
        const removal = removalOf(node, item);
        if (removal?.by !== 'list') { continue; }
        // taking it out of its list leaves one item fewer there, and the node still parses
        const before = childrenOf(node).length;
        const after = childrenOf(view(withList(node, removal.list, { op: 'remove', index: removal.index }, () => text('')))).length;
        expect(after, `${name} ${item.slot.at}`).toBeLessThan(before);
      }
    }
    // a lone branch, case or equal stays: there would be nothing left to choose by
    const lone = view({ kind: 'if', ifs: [{ condition: yes, body: text('a') }] });
    expect(childrenOf(lone).map((c) => removalOf(lone, c))).toEqual([undefined, undefined, { by: 'empty' }]);
    const one = view({ kind: 'switch', value: read('value'), cases: [{ equals: [text('a')], body: text('first') }] });
    expect(childrenOf(one).map((c) => removalOf(one, c))).toEqual([undefined, undefined, undefined, { by: 'empty' }]);
    // an argument the step does not have is not removable
    expect(removalOf(view(NODES.get), { slot: { at: 'step.arg', step: 2, name: 'missing' }, label: '', def: undefined, optional: false, path: '' })).toBeUndefined();
  });

  it('grows, shrinks and reorders the lists a node holds, each result one gin parses, and ignores lists it hasn\'t', () => {
    for (const [name, def] of Object.entries(NODES)) {
      const node = view(def);
      for (const list of LISTS) {
        for (const edit of EDITS) {
          const next = withList(node, list, edit, () => text('more'));
          // every edit gives what gin reads back (a list a node hasn't gives its definition back)
          expect(tools.parse(next).ok, `${name} ${JSON.stringify(list)} ${JSON.stringify(edit)}`).toBe(true);
        }
      }
    }
    const block = view(NODES.block);
    expect(withList(block, { of: 'lines' }, { op: 'add' }, () => text('three'))).toMatchObject({ lines: [text('one'), text('two'), text('three')] });
    expect(withList(block, { of: 'lines' }, { op: 'move', index: 0, by: 1 }, () => text(''))).toMatchObject({ lines: [text('two'), text('one')] });
    expect(withList(block, { of: 'cases' }, { op: 'add' }, () => text(''))).toEqual(block.def);
    // a new call argument and a new variable take names not yet used
    const get = view(NODES.get);
    const grown = withList(get, { of: 'args', step: 2 }, { op: 'add' }, () => text('c'));
    expect(JSON.stringify(grown)).toContain('"arg2"');
    const define = view(NODES.define);
    expect(withList(define, { of: 'vars' }, { op: 'add' }, () => text('c'))).toMatchObject({ vars: [{ name: 'x' }, { name: 'y' }, { name: 'x2' }] });
    expect(withList(get, { of: 'steps' }, { op: 'add', step: 'key' }, () => text(''))).toMatchObject({ path: [{}, {}, {}, {}, { key: { kind: 'new', value: 0 } }] });
  });

  it('changes a plain field a node has, keeping what gin parses, and leaves the others', () => {
    for (const [name, def] of Object.entries(NODES)) {
      const node = view(def);
      for (const edit of SCALARS) {
        const next = withScalar(node, edit);
        expect(tools.parse(next).ok, `${name} ${JSON.stringify(edit)}`).toBe(true);
      }
    }
    const loop = view(NODES.loop);
    expect(withScalar(loop, { field: 'loop-key', name: '' })).not.toHaveProperty('key');
    expect(withScalar(loop, { field: 'loop-value', name: 'row' })).toMatchObject({ value: 'row' });
    expect(withScalar(view({ ...text('hi'), comment: 'kept' }), { field: 'new-type', type: { name: 'num' } })).toEqual({ kind: 'new', type: { name: 'num' }, comment: 'kept' });
    expect(withScalar(view(NODES.return), { field: 'action', action: 'continue' })).toEqual({ kind: 'flow', action: 'continue' });
    expect(withScalar(view(NODES.get), { field: 'arg', step: 2, from: 'arg', to: 'first' })).toMatchObject({ path: [{}, {}, { args: { first: text('a'), other: text('b') } }, {}] });
    expect(withScalar(view(NODES.if), { field: 'template', text: 'x' })).toEqual(NODES.if);
    expect(withScalar(view(NODES.block), { field: 'comment', text: 'steps' })).toMatchObject({ comment: 'steps' });
  });

  it('finds the problems at a path and under it, one mark per place', () => {
    const problems = [
      { path: '', message: 'top', severity: 'error' as const },
      { path: 'ifs.0.condition', message: 'not a bool', severity: 'error' as const },
      { path: 'ifs.0.condition', message: 'again', severity: 'warning' as const },
      { path: 'ifs.1.body', message: 'unused', severity: 'info' as const },
    ];
    expect(problemsAt(problems, 'ifs.0.condition').map((p) => p.message)).toEqual(['not a bool', 'again']);
    expect(problemsAt(problems, 'ifs.0', true).map((p) => p.message)).toEqual(['not a bool', 'again']);
    expect(marksWithin(problems, '')).toBe(3);
    expect(marksWithin(problems, 'ifs.1')).toBe(1);
    // gin's own checks, with the scope's variables typed
    const parsed = tools.parse(NODES.if);
    if (!parsed.ok) { throw new Error(parsed.problem); }
    expect(tools.typeText(parsed.value, new Map())).toContain('text');
    expect(tools.code(parsed.value)).toContain('if');
  });
});
