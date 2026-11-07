import { describe, expect, it } from 'vitest';
import { context, hookBlock } from './declare.ts';
import { fn } from './fn.ts';
import { g } from './gin.ts';
import { system } from './system.ts';

const s = system('hooky', { description: 'h' }).with({ fns: { a: fn({ description: 'a', args: g.obj({}), returns: g.text() }) }, context: { c: context({ description: 'c', content: 'x' }) } });

describe('hookBlock', () => {
  it('turns refs into qualified names for the wire', () => {
    expect(hookBlock({ type: 'text', tag: 'git', text: 'main' })).toEqual({ type: 'text', tag: 'git', text: 'main' });
    expect(hookBlock({ type: 'suggest-fns', items: [{ fn: s.fns.a, why: 'fits' }] })).toEqual({ type: 'suggest-fns', items: [{ fn: 'hooky/a', why: 'fits' }] });
    expect(hookBlock({ type: 'suggest-context', items: [{ context: s.context.c }] })).toEqual({ type: 'suggest-context', items: [{ context: 'hooky/c' }] });
    expect(hookBlock({ type: 'load', fns: [s.fns.a] })).toEqual({ type: 'load', fns: ['hooky/a'] });
  });
});
