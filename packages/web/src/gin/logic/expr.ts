/**
 * The expression editor's model. A gin expression (`GinExprDef`, gin's `ExprDef` on the wire) is parsed by gin into
 * its live `Expr` and read into an `ExprView` by gin's own classes: each of gin's twelve node kinds with its own
 * typed definition (`expr.toJSON()`, gin's `IfExprDef`, `GetExprDef`, …), so an edit is that definition with one slot
 * changed and gin's types say what each slot holds. `ExprTools` asks gin for what a node evaluates to (`typeOf`),
 * what is wrong with it (`validate`) and how it reads as code (`toCode`), with the variables in scope typed. Pure
 * (given a registry), so it is tested alone.
 */
import {
  BlockExpr, CallStep, createEngine, DefineExpr, FlowExpr, GetExpr, IfExpr, IndexStep, LambdaExpr, LoopExpr, NativeExpr, NewExpr, PropStep, SetExpr, SwitchExpr,
  TemplateExpr, type BlockExprDef, type DefineExprDef, type Engine, type Expr, type ExprDef, type FlowExprDef, type GetExprDef, type IfExprDef, type LambdaExprDef,
  type LoopExprDef, type NativeExprDef, type NewExprDef, type Path, type PathStepDef, type Registry, type SetExprDef, type SwitchExprDef, type TemplateExprDef,
  type Type,
} from '@aeye/gin';
import { Json } from '@harness/core';
import type { Outcome } from '../../ui/index.ts';

/** One step of a `get` or `set` path, as the editor shows it. */
export type StepView =
  | { readonly kind: 'prop'; readonly name: string }
  | { readonly kind: 'call'; readonly args: readonly (readonly [string, ExprDef])[] }
  | { readonly kind: 'key'; readonly key: ExprDef };

/** A parsed expression, by its kind, with its own typed definition. */
export type ExprView =
  | { readonly kind: 'new'; readonly def: NewExprDef; readonly type: Type; readonly value: Json | undefined }
  | { readonly kind: 'get'; readonly def: GetExprDef; readonly steps: readonly StepView[] }
  | { readonly kind: 'set'; readonly def: SetExprDef; readonly steps: readonly StepView[] }
  | { readonly kind: 'define'; readonly def: DefineExprDef }
  | { readonly kind: 'block'; readonly def: BlockExprDef }
  | { readonly kind: 'if'; readonly def: IfExprDef }
  | { readonly kind: 'switch'; readonly def: SwitchExprDef }
  | { readonly kind: 'loop'; readonly def: LoopExprDef }
  | { readonly kind: 'lambda'; readonly def: LambdaExprDef; readonly type: Type }
  /** `text` is the template as written (gin keeps it as a text value inside the definition). */
  | { readonly kind: 'template'; readonly def: TemplateExprDef; readonly text: string }
  | { readonly kind: 'flow'; readonly def: FlowExprDef }
  | { readonly kind: 'native'; readonly def: NativeExprDef }
  /** A kind this registry adds beyond gin's twelve: shown as code, not edited. */
  | { readonly kind: 'other'; readonly def: ExprDef };

/** gin's twelve expression kinds. */
export type ExprKind = Exclude<ExprView['kind'], 'other'>;

/** The kinds in the order the kind picker lists them, with a label and what each does. */
export const EXPR_KINDS = [
  { kind: 'new', label: 'Value', hint: 'A value of a type' },
  { kind: 'get', label: 'Read', hint: 'A variable, a field or a method call' },
  { kind: 'set', label: 'Write', hint: 'Change a variable or field' },
  { kind: 'template', label: 'Template', hint: 'Text with {placeholders}' },
  { kind: 'if', label: 'If', hint: 'Choose by conditions' },
  { kind: 'switch', label: 'Switch', hint: 'Choose by a value' },
  { kind: 'define', label: 'Define', hint: 'Name values for a body' },
  { kind: 'block', label: 'Block', hint: 'Steps in order' },
  { kind: 'loop', label: 'Loop', hint: 'Repeat over a list' },
  { kind: 'lambda', label: 'Function', hint: 'A callable body' },
  { kind: 'flow', label: 'Flow', hint: 'Return, break, continue, exit or throw' },
  { kind: 'native', label: 'Native', hint: 'A built-in implementation' },
] as const satisfies readonly { readonly kind: ExprKind; readonly label: string; readonly hint: string }[];

/** The label of an expression kind. */
export function exprLabel(kind: ExprView['kind']): string {
  return EXPR_KINDS.find((k) => k.kind === kind)?.label ?? 'Expression';
}

/** gin's flow actions. */
export const FLOW_ACTIONS = ['return', 'break', 'continue', 'exit', 'throw'] as const satisfies readonly FlowExprDef['action'][];

/** The steps of a path, by gin's step classes; each argument and key as its own definition. */
function stepsOf(path: Path): StepView[] {
  return path.steps.flatMap((step): StepView[] => {
    if (step instanceof PropStep) { return [{ kind: 'prop', name: step.prop }]; }
    if (step instanceof CallStep) { return [{ kind: 'call', args: Object.entries(step.args).map(([name, arg]) => [name, arg.toJSON()] as const) }]; }
    if (step instanceof IndexStep) { return [{ kind: 'key', key: step.key.toJSON() }]; }
    return [];
  });
}

/** A path's definition from its steps. */
export function pathOf(steps: readonly StepView[]): PathStepDef[] {
  return steps.map((step): PathStepDef => {
    switch (step.kind) {
      case 'prop': return { prop: step.name };
      case 'call': return { args: Object.fromEntries(step.args) };
      case 'key': return { key: step.key };
    }
  });
}

/** A template's text: gin keeps it as a text value (`new text`); any other expression reads as its code. */
function templateText(expr: TemplateExpr): string {
  const template = expr.template;
  return template instanceof NewExpr && typeof template.value === 'string' ? template.value : template.toCode();
}

/** Read a live expression by gin's classes. */
export function viewOf(expr: Expr): ExprView {
  if (expr instanceof NewExpr) {
    const value = Json.safeParse(expr.value);
    return { kind: 'new', def: expr.toJSON(), type: expr.type, value: value.success ? value.data : undefined };
  }
  if (expr instanceof GetExpr) { return { kind: 'get', def: expr.toJSON(), steps: stepsOf(expr.path) }; }
  if (expr instanceof SetExpr) { return { kind: 'set', def: expr.toJSON(), steps: stepsOf(expr.path) }; }
  if (expr instanceof DefineExpr) { return { kind: 'define', def: expr.toJSON() }; }
  if (expr instanceof BlockExpr) { return { kind: 'block', def: expr.toJSON() }; }
  if (expr instanceof IfExpr) { return { kind: 'if', def: expr.toJSON() }; }
  if (expr instanceof SwitchExpr) { return { kind: 'switch', def: expr.toJSON() }; }
  if (expr instanceof LoopExpr) { return { kind: 'loop', def: expr.toJSON() }; }
  if (expr instanceof LambdaExpr) { return { kind: 'lambda', def: expr.toJSON(), type: expr.fnType }; }
  if (expr instanceof TemplateExpr) { return { kind: 'template', def: expr.toJSON(), text: templateText(expr) }; }
  if (expr instanceof FlowExpr) { return { kind: 'flow', def: expr.toJSON() }; }
  if (expr instanceof NativeExpr) { return { kind: 'native', def: expr.toJSON() }; }
  return { kind: 'other', def: expr.toJSON() };
}

/** What gin said about an expression: a problem at a place in it. */
export interface ExprProblem {
  /** Where in the definition (`ifs.0.condition`; '' for the node itself). */
  readonly path: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

/** A parsed expression, or why gin couldn't read it. */
export type ParsedExpr = Outcome<Expr>;

/** gin's calls the expression editor makes: parsing, the result type, problems and code, over one registry. */
export class ExprTools {
  readonly registry: Registry;
  readonly engine: Engine;

  constructor(registry: Registry) {
    this.registry = registry;
    this.engine = createEngine(registry);
  }

  /** Parse a definition with gin; a refusal is its message. */
  parse(def: ExprDef): ParsedExpr {
    try {
      return { ok: true, value: this.registry.parseExpr(def) };
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What an expression evaluates to, as code (`text`, `list<num>`), with `scope`'s variables typed. */
  typeText(expr: Expr, scope: ReadonlyMap<string, Type>): string {
    return this.engine.typeOf(expr, new Map(scope)).toCode();
  }

  /** gin's problems with an expression, with `scope`'s variables typed. */
  problems(expr: Expr, scope: ReadonlyMap<string, Type>): ExprProblem[] {
    return this.engine.validate(expr, new Map(scope)).list.map((p) => ({ path: p.path.map(String).join('.'), message: p.message, severity: p.severity }));
  }

  /** The expression as gin prints it (TypeScript-flavoured). */
  code(expr: Expr): string {
    return this.engine.toCode(expr);
  }

  /** A new node of a kind: the smallest gin accepts, using a variable in scope where one is needed. */
  blank(kind: ExprKind, variable = 'value'): ExprDef {
    const text = (value: string): NewExprDef => ({ kind: 'new', type: { name: 'text' }, value });
    const read: GetExprDef = { kind: 'get', path: [{ prop: variable }] };
    switch (kind) {
      case 'new': return text('');
      case 'get': return read;
      case 'set': return { kind: 'set', path: [{ prop: variable }], value: text('') } satisfies SetExprDef;
      case 'template': return { kind: 'template', template: `Hello {${variable}}` } satisfies TemplateExprDef;
      case 'if': return { kind: 'if', ifs: [{ condition: { kind: 'new', type: { name: 'bool' }, value: true }, body: text('yes') }], else: text('no') } satisfies IfExprDef;
      case 'switch': return { kind: 'switch', value: read, cases: [{ equals: [text('a')], body: text('first') }], else: text('other') } satisfies SwitchExprDef;
      case 'define': return { kind: 'define', vars: [{ name: 'x', value: text('') }], body: { kind: 'get', path: [{ prop: 'x' }] } } satisfies DefineExprDef;
      case 'block': return { kind: 'block', lines: [text('')] } satisfies BlockExprDef;
      case 'loop': return { kind: 'loop', over: read, body: { kind: 'block', lines: [] } } satisfies LoopExprDef;
      case 'lambda': return { kind: 'lambda', type: this.registry.fn({ args: this.registry.obj({}), returns: this.registry.text() }).toJSON(), body: text('') } satisfies LambdaExprDef;
      case 'flow': return { kind: 'flow', action: 'return', value: text('') } satisfies FlowExprDef;
      case 'native': return { kind: 'native', id: 'text.upper' } satisfies NativeExprDef;
    }
  }
}

/** The problems at one path (and, with `within`, under it). */
export function problemsAt(problems: readonly ExprProblem[], path: string, within = false): ExprProblem[] {
  return problems.filter((p) => p.path === path || (within && (path === '' || p.path.startsWith(`${path}.`))));
}

// ─── Children: the slots of a node that hold expressions ────────────────────

/** A slot of a node that holds an expression, by where it is in the node's definition. */
export type ExprSlot =
  | { readonly at: 'set.value' | 'define.body' | 'if.else' | 'switch.value' | 'switch.else' | 'loop.over' | 'loop.body' | 'lambda.body' | 'lambda.constraint' | 'template.params' | 'flow.value' | 'flow.error' }
  | { readonly at: 'define.var' | 'block.line' | 'if.condition' | 'if.body' | 'switch.body'; readonly index: number }
  | { readonly at: 'switch.equals'; readonly index: number; readonly item: number }
  | { readonly at: 'step.arg'; readonly step: number; readonly name: string }
  | { readonly at: 'step.key'; readonly step: number };

/** One child of a node: its slot, label, definition (absent for an optional slot that is empty) and path. */
export interface ExprChild {
  readonly slot: ExprSlot;
  readonly label: string;
  readonly def: ExprDef | undefined;
  /** May be left empty (an `else`, a lambda's constraint, a template's params, a flow's value). */
  readonly optional: boolean;
  /** Where it is in the node's definition, as gin's problems name it (`ifs.0.condition`). */
  readonly path: string;
}

const child = (slot: ExprSlot, label: string, def: ExprDef | undefined, path: string, optional = false): ExprChild => ({ slot, label, def, optional, path });

/** The children of a step path: each call's arguments and each index's key. */
function stepChildren(steps: readonly StepView[]): ExprChild[] {
  return steps.flatMap((step, i): ExprChild[] => {
    if (step.kind === 'call') { return step.args.map(([name, arg]) => child({ at: 'step.arg', step: i, name }, name, arg, `path.${i}.args.${name}`)); }
    if (step.kind === 'key') { return [child({ at: 'step.key', step: i }, 'Key', step.key, `path.${i}.key`)]; }
    return [];
  });
}

/** Every expression slot of a node, in reading order. Plain fields (names, text, actions) are not children. */
export function childrenOf(view: ExprView): ExprChild[] {
  switch (view.kind) {
    case 'new': case 'native': case 'other': return [];
    case 'get': return stepChildren(view.steps);
    case 'set': return [...stepChildren(view.steps), child({ at: 'set.value' }, 'Value', view.def.value, 'value')];
    case 'define': return [
      ...view.def.vars.map((v, i) => child({ at: 'define.var', index: i }, v.name, v.value, `vars.${i}.value`)),
      child({ at: 'define.body' }, 'Body', view.def.body, 'body'),
    ];
    case 'block': return view.def.lines.map((line, i) => child({ at: 'block.line', index: i }, `Step ${i + 1}`, line, `lines.${i}`));
    case 'if': return [
      ...view.def.ifs.flatMap((branch, i) => [
        child({ at: 'if.condition', index: i }, i === 0 ? 'If' : 'Else if', branch.condition, `ifs.${i}.condition`),
        child({ at: 'if.body', index: i }, 'Then', branch.body, `ifs.${i}.body`),
      ]),
      child({ at: 'if.else' }, 'Else', view.def.else, 'else', true),
    ];
    case 'switch': return [
      child({ at: 'switch.value' }, 'Value', view.def.value, 'value'),
      ...view.def.cases.flatMap((c, i) => [
        ...c.equals.map((e, j) => child({ at: 'switch.equals', index: i, item: j }, j === 0 ? `Case ${i + 1}` : 'or', e, `cases.${i}.equals.${j}`)),
        child({ at: 'switch.body', index: i }, 'Then', c.body, `cases.${i}.body`),
      ]),
      child({ at: 'switch.else' }, 'Else', view.def.else, 'else', true),
    ];
    case 'loop': return [child({ at: 'loop.over' }, 'Over', view.def.over, 'over'), child({ at: 'loop.body' }, 'Body', view.def.body, 'body')];
    case 'lambda': return [child({ at: 'lambda.constraint' }, 'Only when', view.def.constraint, 'constraint', true), child({ at: 'lambda.body' }, 'Body', view.def.body, 'body')];
    case 'template': return [child({ at: 'template.params' }, 'Params', view.def.params, 'params', true)];
    case 'flow': {
      if (view.def.action === 'throw') { return [child({ at: 'flow.error' }, 'Error', view.def.error, 'error', true)]; }
      return view.def.action === 'return' || view.def.action === 'exit' ? [child({ at: 'flow.value' }, 'Value', view.def.value, 'value', true)] : [];
    }
  }
}

/** A step list with one step's call argument or index key replaced. */
function withStepChild(steps: readonly StepView[], slot: Extract<ExprSlot, { at: 'step.arg' | 'step.key' }>, def: ExprDef): StepView[] {
  return steps.map((step, i): StepView => {
    if (i !== slot.step) { return step; }
    if (slot.at === 'step.arg' && step.kind === 'call') { return { kind: 'call', args: step.args.map(([name, arg]) => [name, name === slot.name ? def : arg] as const) }; }
    if (slot.at === 'step.key' && step.kind === 'key') { return { kind: 'key', key: def }; }
    return step;
  });
}

/** A definition with an optional key set, or left out when `value` is undefined. */
function optionalKey<D extends ExprDef, K extends keyof D & string>(def: D, key: K, value: Exclude<D[K], undefined> | undefined): D {
  const next = { ...def };
  if (value === undefined) { Reflect.deleteProperty(next, key); } else { next[key] = value; }
  return next;
}

/** A list with one item replaced. */
function replaceIn<T>(items: readonly T[], index: number, item: T): T[] {
  return items.map((existing, i) => (i === index ? item : existing));
}

/**
 * The node's definition with one slot set (`def`), or, for an optional slot, emptied (`undefined`). A slot that
 * isn't one of the node's (or a required slot emptied) leaves the definition as it was.
 */
export function withChild(view: ExprView, slot: ExprSlot, def: ExprDef | undefined): ExprDef {
  const at = 'index' in slot ? slot.index : -1;
  const isStep = slot.at === 'step.arg' || slot.at === 'step.key';
  switch (view.kind) {
    case 'new': case 'native': case 'other': return view.def;
    case 'get':
      return isStep && def !== undefined ? { ...view.def, path: pathOf(withStepChild(view.steps, slot, def)) } : view.def;
    case 'set':
      if (isStep && def !== undefined) { return { ...view.def, path: pathOf(withStepChild(view.steps, slot, def)) }; }
      return slot.at === 'set.value' && def !== undefined ? { ...view.def, value: def } : view.def;
    case 'define':
      if (slot.at === 'define.var' && def !== undefined) { return { ...view.def, vars: view.def.vars.map((v, i) => (i === at ? { ...v, value: def } : v)) }; }
      return slot.at === 'define.body' && def !== undefined ? { ...view.def, body: def } : view.def;
    case 'block':
      return slot.at === 'block.line' && def !== undefined ? { ...view.def, lines: replaceIn(view.def.lines, at, def) } : view.def;
    case 'if':
      if (slot.at === 'if.condition' && def !== undefined) { return { ...view.def, ifs: view.def.ifs.map((b, i) => (i === at ? { ...b, condition: def } : b)) }; }
      if (slot.at === 'if.body' && def !== undefined) { return { ...view.def, ifs: view.def.ifs.map((b, i) => (i === at ? { ...b, body: def } : b)) }; }
      return slot.at === 'if.else' ? optionalKey(view.def, 'else', def) : view.def;
    case 'switch':
      if (slot.at === 'switch.value' && def !== undefined) { return { ...view.def, value: def }; }
      if (slot.at === 'switch.equals' && def !== undefined) { return { ...view.def, cases: view.def.cases.map((c, i) => (i === at ? { ...c, equals: replaceIn(c.equals, slot.item, def) } : c)) }; }
      if (slot.at === 'switch.body' && def !== undefined) { return { ...view.def, cases: view.def.cases.map((c, i) => (i === at ? { ...c, body: def } : c)) }; }
      return slot.at === 'switch.else' ? optionalKey(view.def, 'else', def) : view.def;
    case 'loop':
      if (slot.at === 'loop.over' && def !== undefined) { return { ...view.def, over: def }; }
      return slot.at === 'loop.body' && def !== undefined ? { ...view.def, body: def } : view.def;
    case 'lambda':
      if (slot.at === 'lambda.body' && def !== undefined) { return { ...view.def, body: def }; }
      return slot.at === 'lambda.constraint' ? optionalKey(view.def, 'constraint', def) : view.def;
    case 'template':
      return slot.at === 'template.params' ? optionalKey(view.def, 'params', def) : view.def;
    case 'flow':
      if (slot.at === 'flow.value') { return optionalKey(view.def, 'value', def); }
      return slot.at === 'flow.error' ? optionalKey(view.def, 'error', def) : view.def;
  }
}

// ─── Lists of a node: steps, lines, branches, cases, variables, arguments ──

/** A list a node holds that can grow and shrink. */
export type ExprList =
  | { readonly of: 'steps' | 'lines' | 'branches' | 'cases' | 'vars' }
  | { readonly of: 'equals'; readonly index: number }
  | { readonly of: 'args'; readonly step: number };

/** What to do to a list: add an item (of a kind, for steps), remove one, or move one. */
export type ListEdit =
  | { readonly op: 'add'; readonly step?: StepView['kind'] }
  | { readonly op: 'remove'; readonly index: number }
  | { readonly op: 'move'; readonly index: number; readonly by: number };

/** A list edited. */
function edited<T>(items: readonly T[], edit: ListEdit, make: () => T): T[] {
  switch (edit.op) {
    case 'add': return [...items, make()];
    case 'remove': return items.filter((_, i) => i !== edit.index);
    case 'move': {
      const next = [...items];
      const [moved] = next.splice(edit.index, 1);
      if (moved === undefined) { return next; }
      next.splice(Math.max(0, Math.min(next.length, edit.index + edit.by)), 0, moved);
      return next;
    }
  }
}

/** A name not yet taken (`arg`, `arg2`, …). */
function fresh(taken: readonly string[], base: string): string {
  const used = new Set(taken);
  if (!used.has(base)) { return base; }
  let n = 2;
  while (used.has(`${base}${n}`)) { n++; }
  return `${base}${n}`;
}

/** A new step of a kind: a field (`name`), a call with no arguments, or an index by 0. */
function blankStep(kind: StepView['kind']): StepView {
  switch (kind) {
    case 'prop': return { kind: 'prop', name: 'name' };
    case 'call': return { kind: 'call', args: [] };
    case 'key': return { kind: 'key', key: { kind: 'new', type: { name: 'num' }, value: 0 } };
  }
}

/** The node's definition with one of its lists edited; `blank` makes a new expression for a new item. */
export function withList(view: ExprView, list: ExprList, edit: ListEdit, blank: () => ExprDef): ExprDef {
  switch (view.kind) {
    case 'get': case 'set': {
      if (list.of === 'steps') { return { ...view.def, path: pathOf(edited(view.steps, edit, () => blankStep(edit.op === 'add' ? edit.step ?? 'prop' : 'prop'))) }; }
      if (list.of !== 'args') { return view.def; }
      const steps = view.steps.map((step, i): StepView => (i === list.step && step.kind === 'call'
        ? { kind: 'call', args: edited(step.args, edit, () => [fresh(step.args.map(([name]) => name), 'arg'), blank()] as const) }
        : step));
      return { ...view.def, path: pathOf(steps) };
    }
    case 'block': return list.of === 'lines' ? { ...view.def, lines: edited(view.def.lines, edit, blank) } : view.def;
    case 'if': return list.of === 'branches' ? { ...view.def, ifs: edited(view.def.ifs, edit, () => ({ condition: { kind: 'new', type: { name: 'bool' }, value: true }, body: blank() })) } : view.def;
    case 'switch':
      if (list.of === 'cases') { return { ...view.def, cases: edited(view.def.cases, edit, () => ({ equals: [blank()], body: blank() })) }; }
      return list.of === 'equals' ? { ...view.def, cases: view.def.cases.map((c, i) => (i === list.index ? { ...c, equals: edited(c.equals, edit, blank) } : c)) } : view.def;
    case 'define': return list.of === 'vars' ? { ...view.def, vars: edited(view.def.vars, edit, () => ({ name: fresh(view.def.vars.map((v) => v.name), 'x'), value: blank() })) } : view.def;
    case 'new': case 'loop': case 'lambda': case 'template': case 'flow': case 'native': case 'other':
      return view.def;
  }
}

// ─── Plain fields of a node: names, text, actions, a value's type and value ─

/** A change to one of a node's plain fields. */
export type ScalarEdit =
  | { readonly field: 'comment'; readonly text: string }
  | { readonly field: 'prop'; readonly step: number; readonly name: string }
  | { readonly field: 'arg'; readonly step: number; readonly from: string; readonly to: string }
  | { readonly field: 'var'; readonly index: number; readonly name: string }
  | { readonly field: 'loop-key' | 'loop-value'; readonly name: string }
  | { readonly field: 'template'; readonly text: string }
  | { readonly field: 'action'; readonly action: FlowExprDef['action'] }
  | { readonly field: 'native'; readonly id: string }
  | { readonly field: 'new-type'; readonly type: NewExprDef['type'] }
  | { readonly field: 'new-value'; readonly value: Json };

/** The comment of a definition kept on a rebuilt one. */
const commentOf = (def: ExprDef): { comment?: string } => (typeof def.comment === 'string' ? { comment: def.comment } : {});

/** The node's definition with one plain field changed. A field the node doesn't have leaves it as it was. */
export function withScalar(view: ExprView, edit: ScalarEdit): ExprDef {
  if (edit.field === 'comment') { return optionalKey(view.def, 'comment', edit.text === '' ? undefined : edit.text); }
  switch (view.kind) {
    case 'get': case 'set': {
      if (edit.field === 'prop') { return { ...view.def, path: pathOf(view.steps.map((s, i): StepView => (i === edit.step && s.kind === 'prop' ? { kind: 'prop', name: edit.name } : s))) }; }
      if (edit.field !== 'arg') { return view.def; }
      const renamed = view.steps.map((s, i): StepView => (i === edit.step && s.kind === 'call' ? { kind: 'call', args: s.args.map(([name, arg]) => [name === edit.from ? edit.to : name, arg] as const) } : s));
      return { ...view.def, path: pathOf(renamed) };
    }
    case 'define': return edit.field === 'var' ? { ...view.def, vars: view.def.vars.map((v, i) => (i === edit.index ? { ...v, name: edit.name } : v)) } : view.def;
    case 'loop':
      if (edit.field === 'loop-key') { return optionalKey(view.def, 'key', edit.name === '' ? undefined : edit.name); }
      return edit.field === 'loop-value' ? optionalKey(view.def, 'value', edit.name === '' ? undefined : edit.name) : view.def;
    case 'template': return edit.field === 'template' ? { ...view.def, template: edit.text } : view.def;
    case 'flow': return edit.field === 'action' ? { kind: 'flow', action: edit.action, ...commentOf(view.def) } : view.def;
    case 'native': return edit.field === 'native' ? { ...view.def, id: edit.id } : view.def;
    case 'new':
      // a new type starts from its default value, since the old value may not fit it
      if (edit.field === 'new-type') { return { kind: 'new', type: edit.type, ...commentOf(view.def) }; }
      return edit.field === 'new-value' ? { ...view.def, value: edit.value } : view.def;
    case 'block': case 'if': case 'switch': case 'lambda': case 'other':
      return view.def;
  }
}

/** How a child is taken out: emptied (an optional slot), removed from its list, or not at all (a required slot). */
export type Removal = { readonly by: 'empty' } | { readonly by: 'list'; readonly list: ExprList; readonly index: number } | undefined;

/** How a child of a node can be taken out, if it can. */
export function removalOf(view: ExprView, child: ExprChild): Removal {
  if (child.optional) { return { by: 'empty' }; }
  const slot = child.slot;
  switch (slot.at) {
    case 'block.line': return { by: 'list', list: { of: 'lines' }, index: slot.index };
    case 'define.var': return { by: 'list', list: { of: 'vars' }, index: slot.index };
    case 'if.condition': return view.kind === 'if' && view.def.ifs.length > 1 ? { by: 'list', list: { of: 'branches' }, index: slot.index } : undefined;
    case 'switch.equals': return view.kind === 'switch' && (view.def.cases[slot.index]?.equals.length ?? 0) > 1 ? { by: 'list', list: { of: 'equals', index: slot.index }, index: slot.item } : undefined;
    case 'switch.body': return view.kind === 'switch' && view.def.cases.length > 1 ? { by: 'list', list: { of: 'cases' }, index: slot.index } : undefined;
    case 'step.arg': {
      const step = view.kind === 'get' || view.kind === 'set' ? view.steps[slot.step] : undefined;
      const index = step?.kind === 'call' ? step.args.findIndex(([name]) => name === slot.name) : -1;
      return index >= 0 ? { by: 'list', list: { of: 'args', step: slot.step }, index } : undefined;
    }
    case 'set.value': case 'define.body': case 'if.else': case 'if.body': case 'switch.value': case 'switch.else': case 'loop.over': case 'loop.body':
    case 'lambda.body': case 'lambda.constraint': case 'template.params': case 'flow.value': case 'flow.error': case 'step.key':
      return undefined;
  }
}
