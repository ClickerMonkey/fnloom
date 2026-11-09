import type { ExprDef } from '@aeye/gin';
import { g } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { editRows, editShape, nodeMenu, type EditPiece, type EditShape } from './logic/expr-edit.ts';
import { ExprTools, viewOf, type ExprView } from './logic/expr.ts';
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

describe('the expression editor laid out as code', () => {
  const view = (def: ExprDef): ExprView => {
    const parsed = tools.parse(def);
    if (!parsed.ok) { throw new Error(parsed.problem); }
    return viewOf(parsed.value);
  };
  /** A row as text: children as `…`, names as typed, buttons left out. */
  const piece = (p: EditPiece): string => {
    switch (p.kind) {
      case 'keyword': case 'punct': return p.text;
      case 'child': return '…';
      case 'name': return p.value === '' ? p.placeholder : p.value;
      case 'template': return `\`${p.text}\``;
      case 'action': return p.action;
      case 'type': return p.text;
      case 'literal': return 'V';
      case 'code': return 'CODE';
      case 'add-arg': case 'add-equals': case 'remove-step': case 'add-line': return '';
    }
  };
  const rows = (def: ExprDef, shape: EditShape, statement = true): string[] => editRows(view(def), shape, statement).map((r) => `${r.indent ? '  ' : ''}${r.pieces.map(piece).join('')}`);

  it('keeps a node on one line while its code fits, and wraps past the width', () => {
    expect(editShape(IF, tools, 0)).toBe('inline');
    expect(editShape(IF, tools, 0, 30)).toBe('block');
    expect(editShape({ kind: 'block', lines: [num(1)] }, tools, 0)).toBe('block');
    expect(editShape({ kind: 'new', type: { name: 'list', generic: { V: { name: 'num' } } }, value: [1, 2] }, tools, 0)).toBe('block');
  });

  it('writes an if as code, with no labels: on one line, or in braces', () => {
    expect(rows(IF, 'inline')).toEqual(['if (…) … else …']);
    expect(rows(IF, 'block')).toEqual(['if (…) {', '  …', '} else {', '  …', '}']);
    const first = editRows(view(IF), 'inline', true)[0]?.pieces[0];
    expect(first).toEqual({ kind: 'keyword', text: 'if', menu: true });
  });

  it('puts a long call’s arguments one per line, and closes it where the path carries on', () => {
    const call: ExprDef = { kind: 'get', path: [{ prop: 'items' }, { prop: 'slice' }, { args: { start: num(1), end: num(2) } }, { prop: 'length' }] };
    expect(rows(call, 'inline')).toEqual(['items.slice(start: …, end: …).length']);
    expect(rows(call, 'block')).toEqual(['items.slice(', '  start: …, ', '  end: …', ').length']);
  });

  it('writes blocks, defines, switches and loops one statement a line', () => {
    expect(rows({ kind: 'block', lines: [num(1), num(2)] }, 'block')).toEqual(['…', '…', '']);
    expect(rows({ kind: 'block', lines: [num(1)] }, 'block', false)).toEqual(['{', '  …', '  ', '}']);
    expect(rows({ kind: 'define', vars: [{ name: 'x', value: num(1) }], body: read('x') }, 'block')).toEqual(['let x = …', '…']);
    expect(rows({ kind: 'switch', value: read('a'), cases: [{ equals: [num(1), num(2)], body: text('one') }], else: text('other') }, 'block'))
      .toEqual(['switch (…) {', '  case …, …: …', '  default: …', '}']);
    expect(rows({ kind: 'loop', over: read('items'), body: { kind: 'block', lines: [] } }, 'block')).toEqual(['for (key, value of …) {', '  …', '}']);
  });

  it('offers what a node can grow, its optional parts, other kinds and taking it out', () => {
    const items = nodeMenu(view({ kind: 'if', ifs: [{ condition: num(1), body: num(2) }] }), true);
    const values = items.flatMap((item) => (item.kind === 'separator' ? [] : [item.value]));
    expect(values.slice(0, 2)).toEqual(['add-branch', 'fill:else']);
    expect(values).toContain('kind:block');
    expect(values).not.toContain('kind:if');
    expect(values.at(-1)).toBe('remove');
    expect(nodeMenu(view(IF), false).some((item) => item.kind !== 'separator' && item.value === 'clear:else')).toBe(true);
  });
});
