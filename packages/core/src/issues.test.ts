/**
 * Short validation problems: a union is followed into the branch the value got furthest into, a union no branch of
 * which got past its tag says which tags fit, a gin type is checked by gin (iteration 1's `create_table` row type),
 * and the list and each line are bounded.
 */
import { createRegistry } from '@aeye/gin';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkGinValue } from './gin-a.ts';
import { GinTypeDef, ginTypeProblem } from './gin.ts';
import { conciseIssues, issueLines, OBJ_TYPE_SHAPE } from './issues.ts';

const Expr: z.ZodType = z.lazy(() => z.union([
  z.object({ kind: z.literal('get'), path: z.array(z.object({ prop: z.string() })) }).strict(),
  z.object({ kind: z.literal('new'), type: z.object({ name: z.string() }), value: Expr.optional() }).strict(),
  z.object({ kind: z.literal('if'), ifs: z.array(z.object({ condition: Expr, body: Expr })) }).strict(),
]));
const Program = z.object({ draft: z.object({ name: z.string(), program: Expr, sample: z.record(z.string(), z.unknown()) }) });

const check = (schema: z.ZodType, value: unknown, limits?: { max?: number; chars?: number }) => {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('it fit');
  return conciseIssues(result.error, value, limits);
};

describe('conciseIssues', () => {
  it('follows a union into the branch the value got furthest into, at the full path', () => {
    const issues = check(Program, { draft: { name: 'x', sample: {}, program: { kind: 'if', ifs: [{ condition: { kind: 'get', path: [{ prop: 1 }] }, body: { kind: 'get', path: [] } }] } } });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('draft.program.ifs.0.condition.path.0.prop');
    expect(issues[0]?.message).toContain('expected string');
  });

  it('says which tags fit when no branch got past its tag', () => {
    const issues = check(Program, { draft: { name: 'x', sample: {}, program: { kind: 'call', fn: 'x' } } });
    expect(issues).toEqual([{ path: 'draft.program', message: 'no form fits; "kind" must be one of: get, new, if' }]);
  });

  it('names a missing field plainly', () => {
    expect(check(Program, { draft: { name: 'x', program: { kind: 'get', path: [] } } })).toEqual([
      { path: 'draft.sample', message: 'Invalid input: expected record, received undefined' },
    ]);
  });

  it('says what is wrong with a gin type at its path (iteration 1: create_table with each column\'s type not wrapped in "type")', () => {
    const registry = createRegistry();
    const type = registry.obj({ table: { type: registry.text() }, type: { type: registry.typ(registry.obj({})) } });
    const paths = (value: unknown): string[] => { const checked = checkGinValue(type, value, { unknownKeys: 'refuse' }); return checked.ok ? [] : checked.problems.map((problem) => problem.path); };
    expect(paths({ table: 't', type: { name: 'obj', props: { id: { name: 'num' }, store: { name: 'text' } } } })).toEqual(['type.props.id.type', 'type.props.store.type']);
    // a row type named like its table, as an extension of obj: its props are still checked
    expect(paths({ table: 't', type: { name: 'grocery_purchases', extends: 'obj', props: { id: { name: 'num' } } } })).toEqual(['type.props.id.type']);
    // only the name is wrong: the type itself doesn't fit (gin's own word for it, `ginTypeProblem`, below)
    expect(paths({ table: 't', type: { name: 'grocery_purchases', props: { id: { type: { name: 'num' } } } } })).toEqual(['type']);
    expect(ginTypeProblem({ name: 'grocery_purchases', props: { id: { type: { name: 'num' } } } })).toContain('"grocery_purchases" is not a type; an object type is named "obj"');
    expect(ginTypeProblem(GinTypeDef.parse({ name: 'obj', props: { id: { name: 'num' } } }))).toContain("prop 'id' has unknown key 'name'");
    expect(OBJ_TYPE_SHAPE).toContain('obj');
  });

  it('keeps to a few problems, each a bounded line, and says how many more', () => {
    const many = z.object(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, z.string()])));
    const issues = check(many, {}, { max: 3, chars: 30 });
    expect(issues).toHaveLength(4);
    expect(issues[3]).toEqual({ path: '', message: 'and 6 more problems like these' });
    expect(issues.every((issue) => issue.message.length <= 30)).toBe(true);
    expect(issueLines(issues.slice(0, 1))).toMatch(/^- f0: /);
  });
});
