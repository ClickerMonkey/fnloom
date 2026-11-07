import { TypeRecord, type QualifiedName } from '@harness/core';
import { g, hub, wireType, type GinType } from '@harness/sdk';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import GinForm from './GinForm.vue';
import { FORM_INPUTS } from './inputs.ts';
import { draftOf, encode, formOf, issueProblems, issueText, parseDuration, type Draft, type FormNode } from './model.ts';
import { FormState } from './state.ts';
import { FORM_TYPES, LOCAL_TYPES, TypeLibrary } from './types.ts';

afterEach(() => { document.body.innerHTML = ''; });

/** A fn's args that use every gin type. */
const EVERY = g.obj({
  path: g.field(g.text({ minLength: 1 }), { docs: 'Where the file is.' }),
  count: g.num({ min: 1, max: 10, whole: true }),
  force: g.bool(),
  mode: g.enum(['fast', 'careful']),
  level: g.enum(['one', 'two', 'three', 'four', 'five']),
  day: g.date(),
  at: g.timestamp(),
  wait: g.duration(),
  tint: g.color(),
  tags: g.list(g.text(), { maxLength: 3 }),
  weights: g.map(g.text(), g.num()),
  pair: g.tuple([g.text(), g.num()]),
  target: g.or([g.text(), g.obj({ line: g.num() })]),
  kind: g.literal('edit'),
  note: g.nullable(g.text()),
  extra: g.any(),
  limit: g.optional(g.num()),
});

const node = formOf(wireType(EVERY));

function fieldNode(name: string): FormNode {
  if (node.kind !== 'obj') { throw new Error('not an object form'); }
  const field = node.fields.find((f) => f.name === name);
  if (field === undefined) { throw new Error(`no field ${name}`); }
  return field.node;
}

describe('formOf', () => {
  it('reads a node for every gin type', () => {
    expect(node.kind).toBe('obj');
    const kinds = node.kind === 'obj' ? Object.fromEntries(node.fields.map((f) => [f.name, f.node.kind])) : {};
    expect(kinds).toEqual({
      path: 'text', count: 'num', force: 'bool', mode: 'enum', level: 'enum', day: 'date', at: 'timestamp', wait: 'duration', tint: 'color',
      tags: 'list', weights: 'map', pair: 'tuple', target: 'or', kind: 'literal', note: 'nullable', extra: 'json', limit: 'num',
    });
    expect(node.kind === 'obj' && node.fields.find((f) => f.name === 'limit')?.optional).toBe(true);
    expect(node.kind === 'obj' && node.fields.find((f) => f.name === 'path')?.docs).toBe('Where the file is.');
    expect(fieldNode('count')).toMatchObject({ min: 1, max: 10, whole: true });
    expect(fieldNode('mode')).toMatchObject({ choices: [{ label: 'Fast', value: 'fast' }, { label: 'Careful', value: 'careful' }] });
    expect(formOf({ name: 'fs/Entry' })).toEqual({ kind: 'ref', docs: '', name: 'fs/Entry' });
    expect(formOf('not a type').kind).toBe('json');
  });

  it("starts a field from gin's default expression, not the expression itself", () => {
    const withDefault = formOf(wireType(g.obj({
      retries: g.field(g.num(), { default: { kind: 'new', type: { name: 'num' }, value: 3 } }),
      computed: g.field(g.num(), { default: { kind: 'get', path: [{ prop: 'retries' }] } }),
    })));
    const fallbacks = withDefault.kind === 'obj' ? Object.fromEntries(withDefault.fields.map((f) => [f.name, f.fallback])) : {};
    expect(fallbacks).toEqual({ retries: 3, computed: undefined });
    const draft = draftOf(withDefault);
    expect(encode(withDefault, draft)).toMatchObject({ ok: false });
    expect(draft.kind === 'fields' && draft.fields['retries']).toEqual({ kind: 'text', text: '3' });
  });
});

describe('drafts', () => {
  it('encodes a filled draft to JSON that gin accepts', () => {
    const value = {
      path: 'a.txt', count: 3, force: true, mode: 'careful', level: 'three', day: '2026-11-07', at: '2026-11-07T10:30:00.000Z', wait: 2_000, tint: 0xff0000,
      tags: ['x', 'y'], weights: [{ key: 'a', value: 1 }], pair: ['p', 2], target: { line: 4 }, kind: 'edit', note: null, extra: { any: [1] },
    };
    const encoded = encode(node, draftOf(node, value));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) { return; }
    expect(encoded.value).toEqual(value);
    expect(LOCAL_TYPES.checker(wireType(EVERY))?.(encoded.value)).toEqual([]);
    expect(EVERY.parse(encoded.value).toLogical().pair).toEqual(['p', 2]);
  });

  it('reports a problem per field it cannot read, and leaves fitting the type to gin', () => {
    const encoded = encode(node, draftOf(node));
    expect(encoded.ok).toBe(false);
    const paths = encoded.ok ? [] : encoded.problems.map((p) => p.path);
    expect(paths).toEqual(['count', 'mode', 'level', 'day', 'at', 'wait', 'pair.1']);
    const unread = encode(fieldNode('count'), { kind: 'text', text: 'lots' });
    expect(unread.ok ? '' : unread.problems[0]?.message).toBe('Enter a number.');
    expect(encode(fieldNode('count'), { kind: 'text', text: '11' })).toEqual({ ok: true, value: 11 });
  });

  it("words gin's issues for people, each at its field", () => {
    /** The problems gin finds with one field's draft. */
    const problems = (type: GinType, draft: Draft): string[] => {
      const form = new FormState(wireType(g.obj({ value: type })));
      form.update({ kind: 'fields', fields: { value: draft }, present: { value: true } });
      return form.problems.value.map((p) => `${p.path}: ${p.message}`);
    };
    expect(problems(g.num({ min: 1, max: 10, whole: true }), { kind: 'text', text: '2.5' })).toEqual(['value: Enter a whole number.']);
    expect(problems(g.num({ min: 1, max: 10, whole: true }), { kind: 'text', text: '11' })).toEqual(['value: At most 10.']);
    expect(problems(g.text({ minLength: 1 }), { kind: 'text', text: '' })).toEqual(['value: Required.']);
    expect(problems(g.text({ minLength: 3, maxLength: 4 }), { kind: 'text', text: 'ab' })).toEqual(['value: At least 3 characters.']);
    expect(problems(g.text({ pattern: '^[a-z]+$' }), { kind: 'text', text: 'A1' })).toEqual(['value: Check the format.']);
    const items = (n: number): Draft => ({ kind: 'items', items: Array.from({ length: n }, (_, i): Draft => ({ kind: 'text', text: String(i) })) });
    expect(problems(g.list(g.text(), { maxLength: 3 }), items(4))).toEqual(['value: At most 3.']);
    expect(problems(g.list(g.text({ minLength: 1 })), { kind: 'items', items: [{ kind: 'text', text: 'a' }, { kind: 'text', text: '' }] })).toEqual(['value.1: Required.']);
    expect(issueText({ code: 'custom', path: [], message: 'not a hash' })).toBe('Not a hash.');
    expect(issueProblems([{ code: 'too_small', origin: 'array', minimum: 2, path: ['files'], message: '' }])).toEqual([{ path: 'files', message: 'Add at least 2.' }]);
  });

  it('leaves absent optional fields out, and reads durations with units', () => {
    const draft = draftOf(node);
    expect(draft.kind === 'fields' && draft.present['limit']).toBe(false);
    expect([parseDuration('1500'), parseDuration('1.5s'), parseDuration('2m'), parseDuration('soon')]).toEqual([1_500, 1_500, 120_000, undefined]);
    expect(LOCAL_TYPES.checker({ name: 'fs/Entry' })).toBeUndefined();
    expect(LOCAL_TYPES.checker(wireType(g.num()))?.('x')).not.toEqual([]);
    expect(LOCAL_TYPES.checker('not a type')).toBeUndefined();
  });
});

/** A system's named type the hub serves: an entry with a path that must not be empty. */
const ENTRY = { name: 'obj', props: { path: { type: { name: 'text', options: { minLength: 1 } } } } };
/** The hub's record of it, as the `types` endpoint returns it. */
const ENTRY_RECORD = TypeRecord.parse({ name: 'fs/Entry', system: 'fs', description: 'An entry.', def: ENTRY, display: { label: 'Entry' }, references: [], updatedAt: 0 });

describe('TypeLibrary', () => {
  it('loads the named types a definition refers to once, then checks values with them bound', async () => {
    const asked: QualifiedName[][] = [];
    const library = new TypeLibrary((names) => {
      asked.push([...names]);
      return Promise.resolve({
        types: [ENTRY_RECORD],
        missing: names.filter((n) => n !== 'fs/Entry'),
      });
    });
    const def = { name: 'obj', props: { entry: { type: { name: 'fs/Entry' } }, ghost: { type: { name: 'ghost/Thing' } } } };
    expect(library.checker(def)).toBeUndefined();
    expect(await library.need([def])).toBe(true);
    expect(asked).toEqual([['fs/Entry', 'ghost/Thing']]);
    expect(await library.need([def])).toBe(false);
    expect(asked).toHaveLength(1);
    const check = library.checker({ name: 'fs/Entry' });
    expect(check?.({ path: 'a.txt' })).toEqual([]);
    expect(issueProblems(check?.({ path: '' }) ?? [])).toEqual([{ path: 'path', message: 'Required.' }]);
    expect(library.definition('hub/LongText')).toMatchObject({ name: 'hub/LongText', extends: 'text' });
  });

  it('enters a named type as its definition, and the hub’s LongText as many lines', async () => {
    const node = formOf(wireType(g.obj({ text: hub.types.LongText })), '', (name) => LOCAL_TYPES.definition(name));
    const text = node.kind === 'obj' ? node.fields[0]?.node : undefined;
    expect(text).toMatchObject({ kind: 'ref', name: 'hub/LongText', inner: { kind: 'text', multiline: true } });
    const form = new FormState(wireType(g.obj({ text: hub.types.LongText })));
    form.update({ kind: 'fields', fields: { text: { kind: 'text', text: 'hello undo' } }, present: { text: true } });
    expect(form.check()).toEqual({ ok: true, value: { text: 'hello undo' } });
    const library = new TypeLibrary(() => Promise.resolve({
      types: [ENTRY_RECORD], missing: [],
    }));
    const mounted = mount(GinForm, { props: { type: { name: 'obj', props: { entry: { type: { name: 'fs/Entry' } } } } }, global: { provide: { [FORM_TYPES]: library } } });
    await flushPromises();
    expect(mounted.find('[data-path="entry.path"] input').exists()).toBe(true);
  });
});

describe('FormState', () => {
  it('shows problems once the person starts, and checks with gin', () => {
    const form = new FormState(wireType(g.obj({ name: g.text({ minLength: 1 }) })));
    expect(form.problems.value).toEqual([]);
    expect(form.valid.value).toBe(false);
    form.update({ kind: 'fields', fields: { name: { kind: 'text', text: '' } }, present: { name: true } });
    expect(form.problems.value).toEqual([{ path: 'name', message: 'Required.' }]);
    form.update({ kind: 'fields', fields: { name: { kind: 'text', text: 'Ada' } }, present: { name: true } });
    expect(form.check()).toEqual({ ok: true, value: { name: 'Ada' } });
    form.reset();
    expect(form.tried.value).toBe(false);
  });
});

describe('GinForm', () => {
  it('renders a control for every gin type and submits only a valid value', async () => {
    const form = mount(GinForm, { props: { type: wireType(EVERY) }, attachTo: document.body });
    const paths = form.findAll('[data-testid=gin-input]').map((w) => w.attributes('data-path'));
    expect(paths).toEqual(expect.arrayContaining(['path', 'count', 'force', 'mode', 'level', 'day', 'at', 'wait', 'tint', 'tags', 'weights', 'pair', 'target', 'kind', 'note', 'extra']));
    expect(form.find('select').exists()).toBe(true);
    expect(form.find('input[type=color]').exists()).toBe(true);
    expect(form.find('input[type=date]').exists()).toBe(true);
    expect(form.find('input[type=datetime-local]').exists()).toBe(true);
    expect(form.get('[data-testid=gin-submit]').attributes('disabled')).toBeDefined();
    await form.get('[data-path=path] input').setValue('a');
    await form.get('[data-path=path] input').setValue('');
    expect(form.text()).toContain('Required.');
    await form.get('form').trigger('submit');
    expect(form.emitted('submit')).toBeUndefined();
  });

  it('adds and removes list items and optional fields', async () => {
    const type = wireType(g.obj({ tags: g.list(g.text()), limit: g.optional(g.num()) }));
    const form = mount(GinForm, { props: { type }, attachTo: document.body });
    const add = form.findAll('button').find((b) => b.text() === 'Add');
    await add?.trigger('click');
    expect(form.findAll('[data-path="tags.0"]')).toHaveLength(1);
    const optional = form.findAll('button').find((b) => b.text() === 'Limit');
    await optional?.trigger('click');
    expect(form.find('[data-path=limit]').exists()).toBe(true);
    await form.get('[data-path="tags.0"] input').setValue('urgent');
    await form.get('[data-path=limit] input').setValue('5');
    await flushPromises();
    await form.get('form').trigger('submit');
    expect(form.emitted('submit')?.[0]).toEqual([{ tags: ['urgent'], limit: 5 }]);
  });

  it('uses a system’s own input for its named types', () => {
    const EntryInput = defineComponent({ props: { modelValue: { type: null, default: undefined }, problems: { type: Array, default: () => [] } }, setup: () => () => h('div', { class: 'entry-input' }, 'pick an entry') });
    const form = mount(GinForm, {
      props: { type: { name: 'obj', props: { entry: { type: { name: 'fs/Entry' } } } } },
      global: { provide: { [FORM_INPUTS]: (type: string) => (type === 'fs/Entry' ? { component: EntryInput, props: {} } : undefined) } },
    });
    expect(form.find('.entry-input').exists()).toBe(true);
  });
});
