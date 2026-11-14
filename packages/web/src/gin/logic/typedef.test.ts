/**
 * The type editor's model over every kind: a shape read from gin builds back to the same definition; a kind changed
 * keeps the docs and the inner type where it carries over; the editor's own rules name what is wrong by path before
 * gin is asked; constraints read in words; literals switch kind; list helpers keep inside the list.
 */
import type { TypeDef } from '@aeye/gin';
import { g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import {
  blankShape, boundOf, boundText, buildShape, changeKind, checkShape, constraintText, defOf, freshName, kindLabel, literalAs, literalKind, moveAt, PICKABLE_KINDS,
  removeAt, replaceAt, shapeOf, shapeProblems, withOption, type TypeShape,
} from './typedef.ts';

const text: TypeShape = { kind: 'text', docs: '', options: {} };
const parse = (def: TypeDef) => { try { return g.parse(def); } catch { return undefined; } };
const roundTrip = (def: TypeDef): TypeDef => defOf(shapeOf(g.parse(def)), g);

describe('type shapes', () => {
  it('reads every kind gin has and builds it back to the same definition', () => {
    const defs: TypeDef[] = [
      { name: 'text', options: { minLength: 1, maxLength: 40, pattern: '^[a-z]+$' } },
      { name: 'num', options: { whole: true, min: 0, max: 10 } },
      { name: 'bool' }, { name: 'date' }, { name: 'timestamp' }, { name: 'color', options: { hasAlpha: true } }, { name: 'duration' }, { name: 'any' }, { name: 'void' }, { name: 'null' },
      { name: 'list', generic: { V: { name: 'text' } }, options: { minLength: 1 } },
      { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } },
      { name: 'obj', props: { title: { docs: 'The title', type: { name: 'text' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } },
      { name: 'optional', generic: { T: { name: 'text' } } }, { name: 'nullable', generic: { T: { name: 'num' } } },
      { name: 'enum', options: { values: { low: 'low', high: 'high' } }, generic: { T: { name: 'text' } } },
    ];
    for (const def of defs) {
      const parsed = parse(def);
      if (parsed === undefined) { continue; } // a spelling this gin has not: the shapes below build them
      const shape = shapeOf(parsed);
      expect(shape.kind, JSON.stringify(def)).not.toBe('other');
      expect(g.parse(roundTrip(def)).toCode(), JSON.stringify(def)).toBe(parsed.toCode());
    }
    // a field's docs and its optional are kept, and a node's own docs ride on its definition
    const obj = shapeOf(g.parse({ name: 'obj', props: { title: { docs: 'The title', type: { name: 'text' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } }));
    expect(obj).toMatchObject({ kind: 'obj', fields: [{ name: 'title', docs: 'The title', optional: false }, { name: 'due', optional: true, type: { kind: 'date' } }] });
    expect(defOf({ ...text, docs: 'A name' }, g)).toMatchObject({ name: 'text', docs: 'A name' });
    // a literal reads as its value, and builds back to a literal of it
    expect(shapeOf(g.parse({ name: 'literal', options: { value: 3 } }))).toMatchObject({ kind: 'literal', value: 3 });
    expect(buildShape({ kind: 'literal', docs: '', value: 'yes' }, g).toCode()).toContain('yes');
  });

  it('builds every blank kind into a type gin checks, with labels for each', () => {
    for (const { kind, label } of PICKABLE_KINDS) {
      const shape = blankShape(kind, 'docs');
      expect(kindLabel(kind)).toBe(label);
      if (kind === 'ref') { continue; } // a ref names a type the registry would need to know
      const checked = checkShape(shape, g, parse);
      expect(checked.ok, kind).toBe(true);
      expect(buildShape(shape, g).toCode(), kind).toBeTruthy();
    }
    expect(kindLabel('named')).toBe('Named type');
    expect(kindLabel('other')).toBe('Other');
    expect(kindLabel('void')).toBeTruthy();
    // a named type is its name over its base; an enum of numbers stays numbers
    expect(defOf({ kind: 'named', docs: 'A task', name: 'Task', base: blankShape('obj') }, g)).toMatchObject({ name: 'Task' });
    const numbers = buildShape({ kind: 'enum', docs: '', values: [{ label: 'one', value: 1 }, { label: 'two', value: 2 }] }, g);
    expect(numbers.toCode()).toContain('1');
    expect(buildShape({ kind: 'other', docs: '', def: { name: 'text' }, code: 'text' }, g).toCode()).toBe('text');
  });

  it('changes a kind keeping the docs, and the inner type between the wrappers', () => {
    const list: TypeShape = { kind: 'list', docs: 'Tags', item: { kind: 'num', docs: '', options: {} }, options: {} };
    expect(changeKind(list, 'list')).toBe(list);
    expect(changeKind(list, 'optional')).toEqual({ kind: 'optional', docs: 'Tags', inner: list.item });
    expect(changeKind(list, 'nullable')).toMatchObject({ kind: 'nullable', inner: list.item });
    expect(changeKind(list, 'map')).toMatchObject({ kind: 'map', value: list.item });
    expect(changeKind(list, 'or')).toMatchObject({ kind: 'or', variants: [list.item, { kind: 'num' }] });
    expect(changeKind(list, 'text')).toEqual({ kind: 'text', docs: 'Tags', options: {} });
    expect(changeKind({ kind: 'optional', docs: '', inner: text }, 'list')).toMatchObject({ kind: 'list', item: text });
    expect(changeKind({ kind: 'map', docs: '', key: text, value: blankShape('bool') }, 'optional')).toMatchObject({ inner: { kind: 'bool' } });
    expect(changeKind(text, 'obj')).toMatchObject({ kind: 'obj', fields: [{ name: 'name' }] });
  });

  it('names what is wrong by path before gin is asked, and what gin refuses after', () => {
    const shape: TypeShape = {
      kind: 'obj', docs: '', fields: [
        { name: '', docs: '', optional: false, type: text },
        { name: '2nd', docs: '', optional: false, type: text },
        { name: 'size', docs: '', optional: false, type: { kind: 'num', docs: '', options: { min: 5, max: 1 } } },
        { name: 'size', docs: '', optional: false, type: text },
        { name: 'tags', docs: '', optional: false, type: { kind: 'list', docs: '', item: { kind: 'text', docs: '', options: { minLength: 9, maxLength: 2 } }, options: { minLength: 3, maxLength: 1 } } },
        { name: 'pick', docs: '', optional: false, type: { kind: 'enum', docs: '', values: [] } },
        { name: 'level', docs: '', optional: false, type: { kind: 'enum', docs: '', values: [{ label: 'a', value: 'a' }, { label: 'a', value: 'b' }, { label: ' ', value: 'c' }] } },
        { name: 'owner', docs: '', optional: false, type: { kind: 'ref', docs: '', name: 'not a name' } },
        { name: 'pair', docs: '', optional: false, type: { kind: 'tuple', docs: '', elements: [{ kind: 'ref', docs: '', name: '' }] } },
        { name: 'either', docs: '', optional: false, type: { kind: 'or', docs: '', variants: [{ kind: 'enum', docs: '', values: [] }] } },
        { name: 'maybe', docs: '', optional: true, type: { kind: 'optional', docs: '', inner: { kind: 'ref', docs: '', name: '-' } } },
        { name: 'lookup', docs: '', optional: false, type: { kind: 'map', docs: '', key: { kind: 'ref', docs: '', name: '?' }, value: { kind: 'enum', docs: '', values: [] } } },
      ],
    };
    const problems = shapeProblems(shape);
    const where = problems.map((p) => p.path);
    expect(problems.find((p) => p.message === 'Every field needs a name.')?.path).toBe('');
    expect(where).toEqual(expect.arrayContaining(['2nd', 'size', 'tags', 'tags.item', 'pick', 'level', 'owner', 'pair.0', 'either.0', 'maybe.inner', 'lookup.key', 'lookup.value']));
    expect(problems.filter((p) => p.path === 'level').map((p) => p.message)).toEqual(['Every value needs a label.', 'Two values have the same label.']);
    expect(checkShape(shape, g, parse)).toMatchObject({ ok: false });
    expect(shapeProblems({ kind: 'named', docs: '', name: 'bad name', base: { kind: 'enum', docs: '', values: [] } }).map((p) => p.path)).toEqual(['', 'base']);
    // gin refuses what the editor's rules let through, and a definition it can't read back
    expect(checkShape({ kind: 'ref', docs: '', name: 'nowhere/Missing' }, g, () => undefined)).toEqual({ ok: false, problems: [{ path: '', message: "gin can't read this type." }] });
    const clean = checkShape(blankShape('obj'), g, parse);
    expect(clean.ok && clean.code).toContain('name');
  });

  it('says a node\'s constraints in words', () => {
    expect(constraintText({ kind: 'text', docs: '', options: { minLength: 1, maxLength: 40, pattern: '^a', flags: 'i' } })).toBe('1 to 40 characters, matches /^a/i');
    expect(constraintText({ kind: 'text', docs: '', options: { minLength: 2 } })).toBe('2 or more characters');
    expect(constraintText({ kind: 'text', docs: '', options: { maxLength: 9 } })).toBe('up to 9 characters');
    expect(constraintText({ kind: 'num', docs: '', options: { whole: true, min: 0 } })).toBe('whole, 0 or more');
    expect(constraintText({ kind: 'list', docs: '', item: text, options: { maxLength: 3 } })).toBe('up to 3 items');
    expect(constraintText({ kind: 'date', docs: '', options: { min: '2026-01-01', max: '2026-12-31' } })).toBe('from 2026-01-01 until 2026-12-31');
    expect(constraintText({ kind: 'timestamp', docs: '', options: {} })).toBe('');
    expect(constraintText({ kind: 'color', docs: '', options: { hasAlpha: true } })).toBe('with alpha');
    expect(constraintText({ kind: 'color', docs: '', options: {} })).toBe('');
    expect(constraintText({ kind: 'enum', docs: '', values: [{ label: 'low', value: 'low' }, { label: 'high', value: 'high' }] })).toBe('low, high');
    expect(constraintText({ kind: 'literal', docs: '', value: 'x' })).toBe('"x"');
    expect(constraintText(blankShape('obj'))).toBe('');
  });

  it('reads bounds and literals typed into boxes, and keeps list edits inside the list', () => {
    expect(boundOf(' 12 ')).toBe(12);
    expect(boundOf('')).toBeUndefined();
    expect(boundOf('many')).toBeUndefined();
    expect(boundText(undefined)).toBe('');
    expect(boundText(3)).toBe('3');
    expect(withOption({ min: 1, max: 2 }, 'max', undefined)).toEqual({ min: 1 });
    const bounds: { min?: number; max?: number } = { min: 1 };
    expect(withOption(bounds, 'max', 5)).toEqual({ min: 1, max: 5 });
    expect([literalKind(1), literalKind(true), literalKind('a')]).toEqual(['number', 'bool', 'text']);
    expect(literalAs(3, 'text')).toBe('3');
    expect(literalAs('3', 'number')).toBe(3);
    expect(literalAs('three', 'number')).toBe(0);
    expect([literalAs('false', 'bool'), literalAs('', 'bool'), literalAs(0, 'bool'), literalAs('yes', 'bool')]).toEqual([false, false, false, true]);
    expect(replaceAt(['a', 'b'], 1, 'c')).toEqual(['a', 'c']);
    expect(removeAt(['a', 'b'], 0)).toEqual(['b']);
    expect(moveAt(['a', 'b', 'c'], 0, 5)).toEqual(['b', 'c', 'a']);
    expect(moveAt(['a', 'b', 'c'], 2, -9)).toEqual(['c', 'a', 'b']);
    expect(moveAt(['a'], 4, 1)).toEqual(['a']);
    expect(freshName(['field', 'field2'])).toBe('field3');
    expect(freshName([], 'title')).toBe('title');
  });
});
