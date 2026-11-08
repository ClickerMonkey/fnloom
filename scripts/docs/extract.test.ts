/** The API extractor over a fixture package: what each kind of export prints as, and which core types it reaches. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractApi, type ApiItem, type ApiModel } from './extract.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MINI = fileURLToPath(new URL('fixtures/mini/', import.meta.url));

function mini(reachDepth = 1): ApiModel {
  return extractApi({
    root: ROOT,
    entries: [{ specifier: '@fixture/mini', file: `${MINI}index.ts` }],
    reach: (file) => file.endsWith('fixtures/mini/core.ts'),
    reachDepth,
  });
}

const model = mini();
const item = (name: string, list: readonly ApiItem[] = model.exports): ApiItem => {
  const found = list.find((i) => i.name === name);
  if (found === undefined) { throw new Error(`no ${name}`); }
  return found;
};

describe('extractApi', { timeout: 60_000 }, () => {
  it('lists every export once, in declaration order, with its module and file', () => {
    expect(model.exports.map((i) => i.name)).toEqual(['shape', 'Painter', 'Mood', 'BRUSHES', 'SIZES', 'Canvas', 'Point']);
    expect(item('Mood')).toMatchObject({ module: '@fixture/mini', file: 'scripts/docs/fixtures/mini/index.ts', kinds: ['type'] });
  });

  it('prints every overload of a function from the checker, and its docs', () => {
    const shape = item('shape');
    expect(shape.kinds).toEqual(['function']);
    expect(shape.code).toBe([
      '/** Make a shape. */',
      'function shape(name: string): Shape;',
      '/** Make a shape from points. */',
      'function shape(points: Shape["points"], name: string): Shape;',
    ].join('\n'));
    expect(shape.docs).toBe('Make a shape.');
  });

  it('prints an interface as written, generics and member docs included', () => {
    const painter = item('Painter');
    expect(painter.code).toContain('interface Painter<C extends Color = Color> {');
    expect(painter.code).toContain('/** Paint a shape in a color. */');
    expect(painter.code).not.toMatch(/^export /);
  });

  it('prints consts with their types', () => {
    expect(item('BRUSHES').code).toBe('const BRUSHES: 3;');
    expect(item('SIZES').code).toBe('const SIZES: readonly ["large", "medium", "small"];');
  });

  it('prints a class without bodies or private members', () => {
    const code = item('Canvas').code;
    expect(item('Canvas').kinds).toEqual(['class']);
    expect(code).toContain('class Canvas implements Painter {');
    expect(code).toContain('/** The shapes painted so far. */\n  readonly painted: Shape[];');
    expect(code).toContain('readonly brushes: 3;');
    expect(code).toContain('constructor(title: string);');
    expect(code).toContain('readonly title: string;');
    expect(code).toContain('paint(shape: Shape, _color: Color): void;');
    expect(code).toContain('get count(): number;');
    expect(code).not.toContain('secret');
    expect(code).not.toContain('hidden');
    expect(code).not.toContain('this.');
  });

  it('resolves a re-exported schema type to plain TypeScript, folding the schema const into it', () => {
    const point = item('Point');
    // a schema and its type: both importable, one entry
    expect(point.kinds).toEqual(['const', 'type']);
    expect(point.code).toBe('type Point = {\n  x: number;\n  y: number;\n};');
    expect(point.docs).toBe('Where a point is.');
  });

  it('records the core shapes the exports refer to, but not core code', () => {
    expect(model.reached.map((i) => i.name)).toEqual(['Color', 'Shape']);
    expect(item('Canvas').reaches).toEqual(['Color', 'Shape']);
    expect(item('Shape', model.reached).code).toContain('points: {');
    expect(model.reached.some((i) => i.name === 'area')).toBe(false);
  });

  it('follows references between reached types only as deep as asked', () => {
    // the package exports Point itself, so it is never listed as reached, however deep
    expect(mini(2).reached.map((i) => i.name)).toEqual(['Color', 'Shape']);
    expect(mini(0).reached).toEqual([]);
  });

  it('documents chosen declarations of an external module', () => {
    const api = extractApi({
      root: ROOT,
      entries: [{ specifier: '@fixture/mini', file: `${MINI}index.ts` }],
      external: [{ specifier: 'zod', from: `${MINI}core.ts`, names: ['ZodError'] }],
      reach: () => false,
      reachDepth: 1,
    });
    expect(api.external.map((i) => [i.name, i.module])).toEqual([['ZodError', 'zod']]);
  });

  it('refuses an external name the module does not export', () => {
    expect(() => extractApi({
      root: ROOT,
      entries: [{ specifier: '@fixture/mini', file: `${MINI}index.ts` }],
      external: [{ specifier: 'zod', from: `${MINI}core.ts`, names: ['NotAThing'] }],
      reach: () => false,
      reachDepth: 1,
    })).toThrow('zod has no export NotAThing');
  });

  it('refuses an entry point that is not in the program', () => {
    expect(() => extractApi({ root: ROOT, entries: [{ specifier: 'x', file: `${MINI}missing.ts` }], reach: () => false, reachDepth: 1 })).toThrow('is not in the program');
  });
});
