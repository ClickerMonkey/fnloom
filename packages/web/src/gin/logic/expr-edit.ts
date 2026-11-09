/**
 * The expression editor laid out as code. Each node is written the way `layout.ts` prints it (`user.name.upper()`,
 * `if (…) {…} else {…}`, `for (key, value of items) {…}`), with its names, text and values as inputs in place: a node
 * stays on one line while it fits the code width, and only then wraps, one statement per line, its parts one level in.
 * Position says what each part is, so there are no labels: a keyword (`if`, `switch`, `for`, `let`, `fn`) opens the
 * node's menu (change its kind, add a branch, a case or a variable, take it out), and a node with no keyword gets a
 * small menu button. Pure, so it is tested alone.
 */
import type { ExprDef } from '@aeye/gin';
import type { MenuItem } from '../../ui/index.ts';
import { childrenOf, EXPR_KINDS, removalOf, viewOf, type ExprChild, type ExprKind, type ExprList, type ExprTools, type ExprView, type ListEdit, type ScalarEdit, type StepView } from './expr.ts';
import { CODE_WIDTH, flatWidth } from './layout.ts';

/** How a node is drawn: on one line, or wrapped over several. */
export type EditShape = 'inline' | 'block';

/** One piece of a line of the editor. */
export type EditPiece =
  /** A keyword; `menu` makes it the button that opens the node's menu. */
  | { readonly kind: 'keyword'; readonly text: string; readonly menu: boolean }
  | { readonly kind: 'punct'; readonly text: string }
  /** A child expression in its place; `statement` when it stands on a line of its own (a block's lines show bare). */
  | { readonly kind: 'child'; readonly child: ExprChild; readonly statement: boolean }
  /** A name typed in place (a variable, field, argument, loop name or native id); `edit` makes the change. */
  | { readonly kind: 'name'; readonly value: string; readonly label: string; readonly placeholder: string; readonly edit: (text: string) => ScalarEdit }
  /** A literal value, with the gin value editor. */
  | { readonly kind: 'literal' }
  | { readonly kind: 'template'; readonly text: string }
  | { readonly kind: 'action'; readonly action: string }
  | { readonly kind: 'type'; readonly text: string }
  /** A kind beyond gin's twelve: its code, read only. */
  | { readonly kind: 'code' }
  /** Buttons that show while the node is active: add a call's argument, a case's value, or take out a path step. */
  | { readonly kind: 'add-arg'; readonly step: number }
  | { readonly kind: 'add-equals'; readonly index: number }
  | { readonly kind: 'remove-step'; readonly step: number }
  /** A faint button closing a block: add a line. */
  | { readonly kind: 'add-line' };

/** One line of a node: its pieces, and whether it sits one level in. */
export interface EditRow {
  readonly indent: boolean;
  readonly pieces: readonly EditPiece[];
}

/** Growing one of a node's lists from its menu. */
export type GrowAction = 'add-line' | 'add-branch' | 'add-case' | 'add-var' | 'add-prop' | 'add-call' | 'add-key';

/** Each grow action: which list it adds to, and how. */
export const GROW_ACTIONS = {
  'add-line': [{ of: 'lines' }, { op: 'add' }],
  'add-branch': [{ of: 'branches' }, { op: 'add' }],
  'add-case': [{ of: 'cases' }, { op: 'add' }],
  'add-var': [{ of: 'vars' }, { op: 'add' }],
  'add-prop': [{ of: 'steps' }, { op: 'add', step: 'prop' }],
  'add-call': [{ of: 'steps' }, { op: 'add', step: 'call' }],
  'add-key': [{ of: 'steps' }, { op: 'add', step: 'key' }],
} as const satisfies Record<GrowAction, readonly [ExprList, ListEdit]>;

/** Whether a menu action grows a list. */
export function isGrowAction(action: string): action is GrowAction {
  return action in GROW_ACTIONS;
}

/** What a node's menu can do. */
export type NodeAction =
  | `kind:${ExprKind}`
  | GrowAction
  /** Fill or empty an optional slot, by its path in the node. */
  | `fill:${string}` | `clear:${string}`
  | 'type' | 'remove';

/** Whether a literal fits on a line: text, numbers, flags, null, or not set yet. */
function scalarValue(view: Extract<ExprView, { kind: 'new' }>): boolean {
  return view.value === undefined || view.value === null || typeof view.value !== 'object';
}

/** The characters a problem mark (the note or error icon behind a node) takes on an edited line. */
export const MARK_WIDTH = 3;

/**
 * How a node is drawn at an indent depth: blocks, defines, switches and loops always wrap, as does a function with a
 * condition and a literal that isn't a plain value; anything else stays on one line while its code and its `marks`
 * (problem icons) fit `width`. An inline node never wraps, so this alone decides where lines break.
 */
export function editShape(def: ExprDef, tools: ExprTools, depth: number, width = CODE_WIDTH, marks = 0): EditShape {
  const parsed = tools.parse(def);
  if (!parsed.ok) { return 'inline'; }
  const view = viewOf(parsed.value);
  switch (view.kind) {
    case 'block': case 'define': case 'switch': case 'loop': case 'other': return 'block';
    case 'lambda': if (view.def.constraint !== undefined) { return 'block'; } break;
    case 'new': if (!scalarValue(view)) { return 'block'; } break;
    case 'get': case 'set': case 'if': case 'template': case 'flow': case 'native': break;
  }
  const flat = flatWidth(def, tools);
  return flat !== undefined && depth * 2 + flat + marks * MARK_WIDTH <= width ? 'inline' : 'block';
}

const kw = (text: string, menu = false): EditPiece => ({ kind: 'keyword', text, menu });
const p = (text: string): EditPiece => ({ kind: 'punct', text });
const row = (pieces: readonly EditPiece[], indent = false): EditRow => ({ indent, pieces });

/** A node's children by their path in it. */
function childMap(view: ExprView): ReadonlyMap<string, ExprChild> {
  return new Map(childrenOf(view).map((c) => [c.path, c]));
}

/** The rows of a node, given its shape; `statement` drops a block's or a define's braces (it stands on its own lines). */
export function editRows(view: ExprView, shape: EditShape, statement: boolean): EditRow[] {
  const kids = childMap(view);
  /** A child in place; an empty optional slot gives nothing (the menu fills it). */
  const at = (path: string, standalone = false): EditPiece[] => {
    const c = kids.get(path);
    return c?.def === undefined ? [] : [{ kind: 'child', child: c, statement: standalone }];
  };
  const wrap = shape === 'block';
  /** A braced body: `{`, the body's lines one level in, `}`. */
  const body = (head: readonly EditPiece[], path: string, close: readonly EditPiece[] = [p('}')]): EditRow[] => [
    row([...head, p(' {')]), row(at(path, true), true), row(close),
  ];

  switch (view.kind) {
    case 'new': return [row([{ kind: 'literal' }])];
    case 'other': return [row([{ kind: 'code' }])];
    case 'native': return [row([kw('native', true), p('("'), name(view.def.id, 'Native id', 'num.add', (id) => ({ field: 'native', id })), p('")')])];
    case 'template': {
      const text: EditPiece = { kind: 'template', text: view.text };
      return [row(view.def.params === undefined ? [text] : [kw('format'), p('('), text, p(', '), ...at('params'), p(')')])];
    }
    case 'flow': {
      const value = view.def.action === 'throw' ? at('error') : at('value');
      return [row([{ kind: 'action', action: view.def.action }, ...(value.length > 0 ? [p(' '), ...value] : [])])];
    }
    case 'get': case 'set': {
      const rows = stepRows(view.steps, kids, wrap);
      if (view.kind === 'get') { return rows; }
      const last = rows.at(-1);
      return [...rows.slice(0, -1), row([...(last?.pieces ?? []), p(' = '), ...at('value')], last?.indent ?? false)];
    }
    case 'if': {
      if (!wrap) {
        const pieces: EditPiece[] = [];
        view.def.ifs.forEach((_, i) => { pieces.push(...(i === 0 ? [kw('if', true)] : [kw(' else if')]), p(' ('), ...at(`ifs.${i}.condition`), p(') '), ...at(`ifs.${i}.body`)); });
        if (view.def.else !== undefined) { pieces.push(kw(' else '), ...at('else')); }
        return [row(pieces)];
      }
      const rows: EditRow[] = [];
      view.def.ifs.forEach((_, i) => {
        rows.push(row([...(i === 0 ? [kw('if', true)] : [p('} '), kw('else if')]), p(' ('), ...at(`ifs.${i}.condition`), p(') {')]), row(at(`ifs.${i}.body`, true), true));
      });
      if (view.def.else !== undefined) { rows.push(row([p('} '), kw('else'), p(' {')]), row(at('else', true), true)); }
      rows.push(row([p('}')]));
      return rows;
    }
    case 'switch': {
      const rows: EditRow[] = [row([kw('switch', true), p(' ('), ...at('value'), p(') {')])];
      view.def.cases.forEach((c, i) => {
        const equals = c.equals.flatMap((_, j) => [...(j > 0 ? [p(', ')] : []), ...at(`cases.${i}.equals.${j}`)]);
        rows.push(row([kw('case '), ...equals, { kind: 'add-equals', index: i }, p(': '), ...at(`cases.${i}.body`, true)], true));
      });
      if (view.def.else !== undefined) { rows.push(row([kw('default'), p(': '), ...at('else', true)], true)); }
      rows.push(row([p('}')]));
      return rows;
    }
    case 'define': {
      const lines = [
        ...view.def.vars.map((v, i) => row([kw('let', i === 0), p(' '), name(v.name, `Variable ${i + 1}`, 'x', (text) => ({ field: 'var', index: i, name: text })), p(' = '), ...at(`vars.${i}.value`)], !statement)),
        row(at('body', true), !statement),
      ];
      return statement ? lines : [row([p('{')]), ...lines, row([p('}')])];
    }
    case 'block': {
      const lines = view.def.lines.map((_, i) => row(at(`lines.${i}`, true), !statement));
      const add = row([{ kind: 'add-line' }], !statement);
      return statement ? [...lines, add] : [row([p('{')]), ...lines, add, row([p('}')])];
    }
    case 'loop': {
      const names: EditPiece[] = [
        name(view.def.key ?? '', 'Key name', 'key', (text) => ({ field: 'loop-key', name: text })), p(', '),
        name(view.def.value ?? '', 'Value name', 'value', (text) => ({ field: 'loop-value', name: text })), kw(' of '),
      ];
      return body([kw('for', true), p(' ('), ...names, ...at('over'), p(')')], 'body');
    }
    case 'lambda': {
      const head: EditPiece[] = [kw('fn', true), p(' '), { kind: 'type', text: view.type.toCode() }];
      if (!wrap) { return [row([...head, p(' => '), ...at('body')])]; }
      const constraint = at('constraint');
      return body([...head, ...(constraint.length > 0 ? [kw(' when'), p(' ('), ...constraint, p(')')] : [])], 'body');
    }
  }
}

function name(value: string, label: string, placeholder: string, edit: (text: string) => ScalarEdit): EditPiece {
  return { kind: 'name', value, label, placeholder, edit };
}

/**
 * A path's rows. On one line: `user.orders(limit: 3)[0]`. Wrapped, each call's arguments go one per line, one level
 * in, and the call closes on its own line, where the rest of the path carries on.
 */
function stepRows(steps: readonly StepView[], kids: ReadonlyMap<string, ExprChild>, wrap: boolean): EditRow[] {
  const rows: EditRow[] = [];
  let line: EditPiece[] = [];
  const child = (path: string): EditPiece[] => {
    const c = kids.get(path);
    return c?.def === undefined ? [] : [{ kind: 'child', child: c, statement: false }];
  };
  const removable = steps.length > 1;
  steps.forEach((step, i) => {
    const remove: EditPiece[] = removable ? [{ kind: 'remove-step', step: i }] : [];
    if (step.kind === 'prop') {
      line.push(...(i > 0 ? [p('.')] : []), name(step.name, i === 0 ? 'Variable' : `Field ${i + 1}`, 'name', (text) => ({ field: 'prop', step: i, name: text })), ...remove);
      return;
    }
    if (step.kind === 'key') { line.push(p('['), ...child(`path.${i}.key`), p(']'), ...remove); return; }
    const args = step.args.map(([argName], a): EditPiece[] => [
      name(argName, `Argument ${argName} name`, 'arg', (text) => ({ field: 'arg', step: i, from: argName, to: text })), p(': '), ...child(`path.${i}.args.${argName}`),
      ...(a < step.args.length - 1 ? [p(', ')] : []),
    ]);
    if (!wrap || args.length === 0) {
      line.push(p('('), ...args.flat(), { kind: 'add-arg', step: i }, p(')'), ...remove);
      return;
    }
    rows.push(row([...line, p('(')]));
    rows.push(...args.map((pieces) => row(pieces, true)));
    line = [{ kind: 'add-arg', step: i }, p(')'), ...remove];
  });
  rows.push(row(line));
  return rows;
}

/** The node's menu: what it can turn into, what it can grow, its optional parts, and taking it out. */
export function nodeMenu(view: ExprView, removable: boolean): MenuItem<NodeAction>[] {
  const grow: MenuItem<NodeAction>[] = [];
  switch (view.kind) {
    case 'block': grow.push({ value: 'add-line', label: 'Add a line', icon: 'plus' }); break;
    case 'if': grow.push({ value: 'add-branch', label: 'Add else if', icon: 'plus' }); break;
    case 'switch': grow.push({ value: 'add-case', label: 'Add a case', icon: 'plus' }); break;
    case 'define': grow.push({ value: 'add-var', label: 'Add a variable', icon: 'plus' }); break;
    case 'get': case 'set': grow.push(
      { value: 'add-prop', label: 'Add a field', icon: 'arrow-right' }, { value: 'add-call', label: 'Add a call', icon: 'play' }, { value: 'add-key', label: 'Add an index', icon: 'tree' },
    ); break;
    case 'new': grow.push({ value: 'type', label: 'Change its type', icon: 'braces' }); break;
    case 'template': case 'loop': case 'lambda': case 'flow': case 'native': case 'other': break;
  }
  const optional = childrenOf(view).filter((c) => c.optional).map((c): MenuItem<NodeAction> => (c.def === undefined
    ? { value: `fill:${c.path}`, label: `Add ${c.label.toLowerCase()}`, icon: 'plus' }
    : { value: `clear:${c.path}`, label: `Take out ${c.label.toLowerCase()}`, icon: 'minus' }));
  const kinds = EXPR_KINDS.filter((k) => k.kind !== view.kind).map((k): MenuItem<NodeAction> => ({ value: `kind:${k.kind}`, label: `Make it ${k.label.toLowerCase()}`, hint: k.hint }));
  const sep: MenuItem<NodeAction> = { kind: 'separator' };
  return [
    ...grow, ...optional, ...(grow.length + optional.length > 0 ? [sep] : []),
    ...kinds,
    ...(removable ? [sep, { value: 'remove' as const, label: 'Take it out', icon: 'x' as const, danger: true }] : []),
  ];
}

/** The child a menu action's slot path names, and whether it can be taken out of its node. */
export function childOf(view: ExprView, path: string): ExprChild | undefined {
  return childMap(view).get(path);
}

/** Whether a child can be taken out of its node (an optional slot, or an item of a list that keeps one). */
export function canRemove(view: ExprView, child: ExprChild): boolean {
  return removalOf(view, child) !== undefined;
}
