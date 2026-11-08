import type { ExprDef } from '@aeye/gin';
import { g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { ExprTools } from './logic/expr.ts';
import { codeText, layoutExpr, nodePaths } from './logic/layout.ts';

const tools = new ExprTools(g);
const num = (value: number): ExprDef => ({ kind: 'new', type: { name: 'num' }, value });
const text = (value: string): ExprDef => ({ kind: 'new', type: { name: 'text' }, value });
const read = (...names: string[]): ExprDef => ({ kind: 'get', path: names.map((prop) => ({ prop })) });
const code = (def: ExprDef, width?: number): string => codeText(layoutExpr(def, tools, width));

const IF: ExprDef = {
  kind: 'if',
  ifs: [{ condition: { kind: 'get', path: [{ prop: 'count' }, { prop: 'gt' }, { args: { other: num(3) } }] }, body: { kind: 'template', template: 'Many for {name}' } }],
  else: text('A few'), comment: 'How many',
};

describe('laying out an expression as code', () => {
  it('keeps a node on one line while it fits', () => {
    expect(code(IF)).toBe('if (count.gt(other: 3)) `Many for {name}` else "A few"');
  });

  it('wraps a node that passes the width into braces, one statement a line', () => {
    expect(code(IF, 30)).toBe(['if (count.gt(other: 3)) {', '  `Many for {name}`', '} else {', '  "A few"', '}'].join('\n'));
  });

  it('puts one argument on each line when a call does not fit', () => {
    const call: ExprDef = { kind: 'get', path: [{ prop: 'items' }, { prop: 'slice' }, { args: { start: num(10_000_000), end: num(20_000_000) } }] };
    expect(code(call, 20)).toBe(['items.slice(', '  start: 10000000,', '  end: 20000000', ')'].join('\n'));
  });

  it('writes blocks, defines, loops and flow as statements', () => {
    const def: ExprDef = {
      kind: 'block', lines: [
        { kind: 'define', vars: [{ name: 'total', value: num(0) }], body: read('total') },
        { kind: 'loop', over: read('items'), key: 'i', value: 'item', body: { kind: 'block', lines: [{ kind: 'set', path: [{ prop: 'total' }], value: read('item') }] } },
        { kind: 'flow', action: 'return', value: read('total') },
      ],
    };
    expect(code(def)).toBe(['let total = 0', 'total', 'for (i, item of items) {', '  total = item', '}', 'return total'].join('\n'));
  });

  it('marks every node on the line it starts on, with its comment as a note', () => {
    const lines = layoutExpr(IF, tools, 30);
    expect(lines[0]?.marks).toContainEqual({ path: '', note: 'How many' });
    const marked = lines.flatMap((l) => l.marks.map((m) => m.path)).sort();
    expect(marked).toEqual([...new Set(nodePaths(IF, tools))].sort());
  });
});
