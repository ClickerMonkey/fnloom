import type { ExprDef, TextOptions } from '@aeye/gin';
import { isGinTypeDef, type Json } from '@harness/core';
import { g, type InputMount } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import GinExprView from './GinExprView.vue';
import GinTypeView from './GinTypeView.vue';
import GinValueView from './GinValueView.vue';
import { childrenOf, ExprTools, removalOf, viewOf, withChild, withList, withScalar, type ExprView } from './logic/expr.ts';
import { colorText, dateText, durationText, enumText, optionOf, presentFields, summary } from './logic/display.ts';
import { formOf, type FormNode } from './logic/form.ts';
import {
  blankShape, boundOf, changeKind, checkShape, constraintText, defOf, freshName, literalAs, moveAt, shapeOf, shapeProblems, withOption, type TypeShape,
} from './logic/typedef.ts';
import { drawerFor, GIN_INPUTS } from './registry.ts';
import { TypeEditor, ValueEditor } from './state.ts';
import { LOCAL_TYPES } from './types.ts';

afterEach(() => { document.body.innerHTML = ''; });

const tools = new ExprTools(g);

/** A gin type with every kind of field. */
const EVERY = g.obj({
  path: g.field(g.text({ minLength: 1, maxLength: 40 }), { docs: 'Where it is.' }),
  count: g.optional(g.num({ min: 1, whole: true })),
  on: g.bool(),
  mode: g.enum(['fast', 'careful']),
  at: g.timestamp(),
  wait: g.duration(),
  tint: g.color(),
  tags: g.list(g.text(), { maxLength: 3 }),
  weights: g.map(g.text(), g.num()),
  pair: g.tuple([g.text(), g.num()]),
  target: g.or([g.text(), g.obj({ line: g.num() })]),
  owner: g.nullable(g.text()),
  kind: g.literal('edit'),
}).toJSON();

const node = (def: unknown): FormNode => formOf(def, '', LOCAL_TYPES);
const parse = (def: ExprDef): ExprView => {
  const parsed = tools.parse(def);
  if (!parsed.ok) { throw new Error(parsed.problem); }
  return viewOf(parsed.value);
};

describe('the registry', () => {
  const custom: InputMount = { component: defineComponent({ setup: () => () => h('span', 'custom') }), props: { system: { online: true, send: {}, run: {} } }, decode: (v) => v, encode: () => undefined };

  it('draws a named type with its system component first, then its definition, then as JSON', () => {
    const named: FormNode = { kind: 'ref', docs: '', name: 'fs/Entry', inner: { kind: 'text', docs: '', multiline: false } };
    expect(drawerFor(named, (name) => (name === 'fs/Entry' ? custom : undefined))).toMatchObject({ kind: 'system', name: 'fs/Entry' });
    expect(drawerFor(named, () => undefined)).toEqual({ kind: 'builtin', node: { kind: 'text', docs: '', multiline: false } });
    expect(drawerFor({ kind: 'ref', docs: '', name: 'fs/Unknown' }, () => undefined)).toEqual({ kind: 'json', name: 'fs/Unknown' });
    expect(drawerFor({ kind: 'json', docs: '' }, () => custom)).toEqual({ kind: 'json', name: '' });
    expect(drawerFor({ kind: 'num', docs: '', whole: false }, () => custom).kind).toBe('builtin');
  });
});

describe('the value viewer words', () => {
  it('says durations in their two largest units', () => {
    expect(durationText(250)).toBe('250 ms');
    expect(durationText(1_500)).toBe('1.5 s');
    expect(durationText(125_000)).toBe('2 min 5 s');
    expect(durationText(5_400_000)).toBe('1 h 30 min');
    expect(durationText(-2_000)).toBe('-2 s');
  });

  it('reads colours, dates, enums and unions', () => {
    expect(colorText(0x3b82f6)).toBe('#3b82f6');
    expect(colorText('blue')).toBeUndefined();
    expect(dateText('not a date')).toBe('not a date');
    const shape = node(EVERY);
    if (shape.kind !== 'obj') { throw new Error('expected an object'); }
    const mode = shape.fields.find((f) => f.name === 'mode')?.node;
    if (mode?.kind !== 'enum') { throw new Error('expected an enum'); }
    expect(enumText(mode, 'careful')).toBe('Careful');
    const target = shape.fields.find((f) => f.name === 'target')?.node;
    if (target?.kind !== 'or') { throw new Error('expected a union'); }
    expect(optionOf(target, 'a.md')).toBe(0);
    expect(optionOf(target, { line: 3 })).toBe(1);
  });

  it('summarises composites and lists only the fields that are set', () => {
    const shape = node(EVERY);
    if (shape.kind !== 'obj') { throw new Error('expected an object'); }
    const value: Json = { path: 'a', on: true, tags: ['x', 'y'], weights: [{ key: 'a', value: 1 }] };
    expect(presentFields(shape, value).map((f) => f.field.name)).toEqual(['path', 'on', 'tags', 'weights']);
    expect(summary(shape, value)).toBe('path, on and 2 more');
    const tags = shape.fields.find((f) => f.name === 'tags')?.node;
    expect(tags === undefined ? '' : summary(tags, ['x', 'y'])).toBe('2 items');
    expect(summary(shape, undefined)).toBe('Not set');
    expect(summary(shape, null)).toBe('None');
  });
});

describe('the type editor model', () => {
  it('reads a type into a shape and builds it back into the same definition', () => {
    const type = LOCAL_TYPES.type(EVERY);
    if (type === undefined) { throw new Error('unreadable'); }
    const shape = shapeOf(type);
    expect(shape.kind).toBe('obj');
    if (shape.kind !== 'obj') { return; }
    expect(shape.fields.map((f) => `${f.name}${f.optional ? '?' : ''}:${f.type.kind}`)).toEqual([
      'path:text', 'count?:num', 'on:bool', 'mode:enum', 'at:timestamp', 'wait:duration', 'tint:color', 'tags:list', 'weights:map', 'pair:tuple', 'target:or', 'owner:nullable', 'kind:literal',
    ]);
    expect(shape.fields[0]).toMatchObject({ docs: 'Where it is.', type: { kind: 'text', options: { minLength: 1, maxLength: 40 } } });
    const again = LOCAL_TYPES.type(defOf(shape, g));
    expect(again?.toCode()).toBe(type.toCode());
  });

  it('reads a named type at the root as its definition and below it as a reference', () => {
    const named = g.extend(g.obj({ id: g.text() }), { name: 'Customer' });
    const root = shapeOf(named);
    expect(root).toMatchObject({ kind: 'named', name: 'Customer', base: { kind: 'obj' } });
    expect(shapeOf(g.list(named))).toMatchObject({ kind: 'list', item: { kind: 'ref', name: 'Customer' } });
  });

  it('changes kinds keeping the docs and the type a wrapper holds', () => {
    const list: TypeShape = { kind: 'list', docs: 'Files', item: blankShape('num'), options: {} };
    expect(changeKind(list, 'optional')).toEqual({ kind: 'optional', docs: 'Files', inner: blankShape('num') });
    expect(changeKind(list, 'text')).toEqual({ kind: 'text', docs: 'Files', options: {} });
    expect(changeKind(list, 'list')).toBe(list);
  });

  it('finds problems before gin is asked, and gin refuses what it refuses', () => {
    const obj: TypeShape = { kind: 'obj', docs: '', fields: [{ name: 'a', docs: '', optional: false, type: blankShape('text') }, { name: 'a', docs: '', optional: false, type: { kind: 'num', docs: '', options: { min: 5, max: 1 } } }, { name: '1x', docs: '', optional: false, type: blankShape('text') }] };
    expect(shapeProblems(obj).map((p) => p.message)).toEqual([
      'There are two fields named a.', 'The smallest value is above the largest.', 'A field name is letters, digits and _, not starting with a digit.',
    ]);
    expect(shapeProblems({ kind: 'enum', docs: '', values: [] })).toEqual([{ path: '', message: 'Add at least one value.' }]);
    expect(shapeProblems({ kind: 'ref', docs: '', name: 'not a name' })[0]?.message).toContain('type name');
    const checked = checkShape(blankShape('obj'), g, (d) => LOCAL_TYPES.type(d));
    expect(checked).toMatchObject({ ok: true, code: 'obj{name: text}' });
  });

  it('words constraints and edits options, names, literals and lists', () => {
    expect(constraintText({ kind: 'text', docs: '', options: { minLength: 1, maxLength: 40, pattern: '^a' } })).toBe('1 to 40 characters, matches /^a/');
    expect(constraintText({ kind: 'num', docs: '', options: { whole: true, min: 0 } })).toBe('whole, 0 or more');
    expect(withOption({ minLength: 1, maxLength: 4 }, 'maxLength', undefined)).toEqual({ minLength: 1 });
    expect(withOption<TextOptions, 'pattern'>({}, 'pattern', 'x')).toEqual({ pattern: 'x' });
    expect(boundOf(' 12 ')).toBe(12);
    expect(boundOf('')).toBeUndefined();
    expect(boundOf('x')).toBeUndefined();
    expect(literalAs('3', 'number')).toBe(3);
    expect(literalAs('false', 'bool')).toBe(false);
    expect(literalAs(7, 'text')).toBe('7');
    expect(freshName(['field', 'field2'])).toBe('field3');
    expect(moveAt(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
});

describe('the expression model', () => {
  const IF: ExprDef = {
    kind: 'if',
    ifs: [{ condition: { kind: 'get', path: [{ prop: 'count' }, { prop: 'gt' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } }] }, body: { kind: 'new', type: { name: 'text' }, value: 'many' } }],
    else: { kind: 'new', type: { name: 'text' }, value: 'few' },
  };
  const scope = new Map([['count', g.num()]]);

  it('reads every kind gin has into its view', () => {
    for (const kind of ['new', 'get', 'set', 'template', 'if', 'switch', 'define', 'block', 'loop', 'lambda', 'flow', 'native'] as const) {
      expect(parse(tools.blank(kind)).kind).toBe(kind);
    }
    const view = parse(IF);
    expect(childrenOf(view).map((c) => `${c.label}@${c.path}`)).toEqual(['If@ifs.0.condition', 'Then@ifs.0.body', 'Else@else']);
    const read = parse(childrenOf(view)[0]?.def ?? IF);
    expect(read.kind === 'get' ? read.steps.map((s) => s.kind) : []).toEqual(['prop', 'prop', 'call']);
  });

  it('asks gin what an expression gives, what is wrong with it and how it reads', () => {
    const parsed = tools.parse(IF);
    if (!parsed.ok) { throw new Error(parsed.problem); }
    expect(tools.typeText(parsed.value, scope)).toBe('or<text, text>');
    expect(tools.code(parsed.value)).toContain('count.gt');
    const unknown = tools.parse({ kind: 'get', path: [{ prop: 'nothing' }] });
    if (!unknown.ok) { throw new Error(unknown.problem); }
    expect(tools.problems(unknown.value, scope).some((p) => p.severity === 'error')).toBe(true);
    expect(tools.parse({ kind: 'nonsense' }).ok).toBe(false);
  });

  it('sets, empties and removes children, and edits lists and plain fields', () => {
    const view = parse(IF);
    const [condition, , otherwise] = childrenOf(view);
    if (condition === undefined || otherwise === undefined) { throw new Error('missing children'); }
    const swapped = parse(withChild(view, condition.slot, { kind: 'new', type: { name: 'bool' }, value: false }));
    expect(childrenOf(swapped)[0]?.def).toMatchObject({ kind: 'new', value: false });
    expect(removalOf(view, otherwise)).toEqual({ by: 'empty' });
    expect(removalOf(view, condition)).toBeUndefined();
    const noElse = parse(withChild(view, otherwise.slot, undefined));
    expect(childrenOf(noElse).map((c) => c.def === undefined)).toEqual([false, false, true]);
    const two = parse(withList(view, { of: 'branches' }, { op: 'add' }, () => tools.blank('new')));
    expect(two.kind === 'if' ? two.def.ifs.length : 0).toBe(2);
    const firstOfTwo = childrenOf(two)[0];
    expect(firstOfTwo === undefined ? undefined : removalOf(two, firstOfTwo)).toEqual({ by: 'list', list: { of: 'branches' }, index: 0 });
    const read = parse({ kind: 'get', path: [{ prop: 'name' }] });
    expect(withScalar(read, { field: 'prop', step: 0, name: 'title' })).toEqual({ kind: 'get', path: [{ prop: 'title' }] });
    expect(withList(read, { of: 'steps' }, { op: 'add', step: 'call' }, () => tools.blank('new'))).toEqual({ kind: 'get', path: [{ prop: 'name' }, { args: {} }] });
    expect(withScalar(read, { field: 'comment', text: 'why' })).toMatchObject({ comment: 'why' });
    const flow = parse(tools.blank('flow'));
    expect(withScalar(flow, { field: 'action', action: 'break' })).toEqual({ kind: 'flow', action: 'break' });
    const template = parse(tools.blank('template'));
    expect(template.kind === 'template' ? template.text : '').toBe('Hello {value}');
  });
});

describe('the editors’ state', () => {
  it('emits each edit that fits, keeps the last good value, and starts again from an outside value', () => {
    const editor = new ValueEditor(g.obj({ name: g.text({ minLength: 2 }) }).toJSON(), { name: 'Ada' });
    expect(editor.update({ kind: 'fields', fields: { name: { kind: 'text', text: 'Grace' } }, present: { name: true } })).toEqual({ value: { name: 'Grace' } });
    expect(editor.update({ kind: 'fields', fields: { name: { kind: 'text', text: 'G' } }, present: { name: true } })).toBeUndefined();
    expect(editor.form.value.problems.value.map((p) => p.path)).toEqual(['name']);
    editor.accept({ name: 'Grace' });
    expect(editor.form.value.draft.value).toMatchObject({ fields: { name: { text: 'G' } } });
    editor.accept({ name: 'Alan' });
    expect(editor.form.value.draft.value).toMatchObject({ fields: { name: { text: 'Alan' } } });
  });

  it('emits a definition gin accepts, and nothing for a shape it refuses', () => {
    const editor = new TypeEditor(g.obj({ a: g.text() }).toJSON(), g);
    const shape = editor.shape.value;
    if (shape?.kind !== 'obj') { throw new Error('expected an object'); }
    const changed = editor.update({ ...shape, fields: [...shape.fields, { name: 'b', docs: '', optional: true, type: blankShape('num') }] });
    expect(changed?.def).toEqual(g.obj({ a: g.text(), b: g.optional(g.num()) }).toJSON());
    expect(editor.update({ ...shape, fields: [{ name: '', docs: '', optional: false, type: blankShape('num') }] })).toBeUndefined();
    expect(new TypeEditor({ name: 'no-such-type{' }, g).unreadable.value).not.toBe('');
  });
});

describe('the components', () => {
  it('edits a value with an input for each kind and emits what fits', async () => {
    const wrapper = mount(GinValueView, { props: { type: EVERY, modelValue: { path: 'a.md', on: false, mode: 'fast', tags: [] } } });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="gin-input"]').length).toBeGreaterThan(10);
    await wrapper.find('[data-path="path"] input').setValue('b.md');
    expect(wrapper.emitted('problems')).toBeDefined();
  });

  it('views a value read only, with the system component for its named type', async () => {
    const Entry = defineComponent({ props: { modelValue: { type: null, default: undefined }, readonly: Boolean }, setup: (props) => () => h('em', { class: 'entry' }, `${String(props.readonly)}:${JSON.stringify(props.modelValue)}`) });
    const input: InputMount = { component: Entry, props: { system: { online: true, send: {}, run: {} } }, decode: (v) => v, encode: (v) => (v === undefined ? undefined : null) };
    const type = g.obj({ file: g.alias('fs/Entry'), size: g.num() }).toJSON();
    const wrapper = mount(GinValueView, { props: { type, modelValue: { file: { path: 'a' }, size: 12 }, readonly: true }, global: { provide: { [GIN_INPUTS]: (name: string) => (name === 'fs/Entry' ? input : undefined) } } });
    await flushPromises();
    expect(wrapper.find('.entry').text()).toBe('true:{"path":"a"}');
    expect(wrapper.text()).toContain('12');
    expect(wrapper.find('input').exists()).toBe(false);
  });

  it('edits a type: adding a field emits the new definition', async () => {
    const wrapper = mount(GinTypeView, { props: { modelValue: g.obj({ a: g.text() }).toJSON() } });
    await flushPromises();
    expect(wrapper.find('[data-testid="gin-type-code"]').text()).toBe('obj{a: text}');
    await wrapper.find('[data-testid="gin-type-add-field"]').trigger('click');
    const emitted = wrapper.emitted('update:modelValue')?.[0]?.[0];
    expect(isGinTypeDef(emitted)).toBe(true);
    expect(LOCAL_TYPES.type(emitted)?.toCode()).toBe('obj{a: text, field: text}');
  });

  it('views a type as a tree without inputs', async () => {
    const wrapper = mount(GinTypeView, { props: { modelValue: EVERY, readonly: true } });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="gin-type-node"]').length).toBeGreaterThan(13);
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).toContain('1 to 40 characters');
  });

  it('views and edits an expression, with what it gives', async () => {
    const def: ExprDef = { kind: 'template', template: 'Hi {name}' };
    const view = mount(GinExprView, { props: { modelValue: def, readonly: true, scope: { name: g.text().toJSON() } } });
    await flushPromises();
    expect(view.find('[data-testid="gin-expr-type"]').text()).toBe('text');
    expect(view.text()).toContain('Hi {name}');
    const edit = mount(GinExprView, { props: { modelValue: def, scope: { name: g.text().toJSON() } } });
    await flushPromises();
    await edit.find('textarea').setValue('Bye {name}');
    expect(edit.emitted('update:modelValue')?.at(-1)?.[0]).toEqual({ kind: 'template', template: 'Bye {name}' });
  });
});
