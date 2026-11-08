/**
 * A gin expression laid out as code, for reading. Each node prints the way a programmer would write it
 * (`count.gt(other: 3)`, `if (…) {…} else {…}`, `for (key, value of items) {…}`): a whole node stays on one line
 * while it fits `width` characters, and only then wraps, one statement per line, its parts indented one level.
 * Blocks and defines are always statements, so they always take their own lines. Each line says which nodes start on
 * it (for gin's problems) and carries their comments as notes, so the viewer can put them behind an info icon. Pure
 * (given `ExprTools`), so it is tested alone.
 */
import type { ExprDef } from '@aeye/gin';
import type { Json } from '@harness/core';
import { childrenOf, viewOf, type ExprTools, type ExprView, type StepView } from './expr.ts';

/** What a piece of code is, for colour. */
export type CodeTokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'literal' | 'punct' | 'type' | 'name';

/** One piece of a line of code. */
export interface CodeToken {
  readonly kind: CodeTokenKind;
  readonly text: string;
}

/** A node that starts on a line: where it is in the expression, and its comment (or ''). */
export interface CodeMark {
  readonly path: string;
  readonly note: string;
}

/** One line of the laid-out expression. */
export interface CodeLine {
  /** Indent levels. */
  readonly depth: number;
  readonly tokens: readonly CodeToken[];
  readonly marks: readonly CodeMark[];
}

/** The widest a line may be, in characters, before a node wraps. */
export const CODE_WIDTH = 80;

/** Characters of one indent level. */
const INDENT = 2;

/** One line's content before it has a depth. */
interface Run {
  readonly tokens: CodeToken[];
  readonly marks: CodeMark[];
}

const tok = (kind: CodeTokenKind, text: string): CodeToken => ({ kind, text });
const punct = (text: string): CodeToken => tok('punct', text);
const kw = (text: string): CodeToken => tok('keyword', text);
const widthOf = (tokens: readonly CodeToken[]): number => tokens.reduce((sum, t) => sum + t.text.length, 0);
const join = (path: string, sub: string): string => (path === '' ? sub : `${path}.${sub}`);

/** A value as a literal: text quoted, numbers and flags as they are, anything else as compact JSON. */
function literal(value: Json): CodeToken {
  if (typeof value === 'string') { return tok('string', JSON.stringify(value)); }
  if (typeof value === 'number') { return tok('number', String(value)); }
  if (typeof value === 'boolean' || value === null) { return tok('literal', String(value)); }
  return tok('plain', JSON.stringify(value));
}

/** Lays out one expression; `tools` reads each child definition with gin. */
class Layout {
  readonly #tools: ExprTools;
  readonly #width: number;

  constructor(tools: ExprTools, width: number) {
    this.#tools = tools;
    this.#width = width;
  }

  /** The view of a definition, or undefined when gin can't read it. */
  private view(def: ExprDef): ExprView | undefined {
    const parsed = this.#tools.parse(def);
    return parsed.ok ? viewOf(parsed.value) : undefined;
  }

  private mark(def: ExprDef, path: string): CodeMark {
    return { path, note: typeof def.comment === 'string' ? def.comment : '' };
  }

  /** The node on one line, or undefined when it never sits on one (blocks, defines, multi-line code). */
  flat(def: ExprDef, path: string): Run | undefined {
    const view = this.view(def);
    if (view === undefined) { return { tokens: [tok('plain', '?')], marks: [this.mark(def, path)] }; }
    const parts = this.flatParts(view, path);
    return parts === undefined ? undefined : { tokens: parts.tokens, marks: [this.mark(def, path), ...parts.marks] };
  }

  /** Several runs joined into one, with `between` tokens; undefined when any is. */
  private glue(items: readonly (Run | CodeToken[] | undefined)[]): Run | undefined {
    const tokens: CodeToken[] = [];
    const marks: CodeMark[] = [];
    for (const item of items) {
      if (item === undefined) { return undefined; }
      if (Array.isArray(item)) { tokens.push(...item); } else { tokens.push(...item.tokens); marks.push(...item.marks); }
    }
    return { tokens, marks };
  }

  /** One step of a path on one line (a field, a call with its arguments, an index), its parts marked at their paths. */
  private flatStep(step: StepView, i: number, path: string): Run | undefined {
    if (step.kind === 'prop') { return { tokens: [...(i > 0 ? [punct('.')] : []), tok(i === 0 ? 'name' : 'plain', step.name)], marks: [] }; }
    if (step.kind === 'key') { return this.glue([[punct('[')], this.flat(step.key, join(path, `path.${i}.key`)), [punct(']')]]); }
    const parts: (Run | CodeToken[] | undefined)[] = [[punct('(')]];
    step.args.forEach(([name, arg], a) => { parts.push([...(a > 0 ? [punct(', ')] : []), tok('plain', `${name}: `)], this.flat(arg, join(path, `path.${i}.args.${name}`))); });
    parts.push([punct(')')]);
    return this.glue(parts);
  }

  /** A whole path on one line. */
  private flatSteps(steps: readonly StepView[], path: string): Run | undefined {
    return this.glue(steps.map((step, i) => this.flatStep(step, i, path)));
  }

  private flatParts(view: ExprView, path: string): Run | undefined {
    const sub = (def: ExprDef | undefined, at: string): Run | undefined => (def === undefined ? undefined : this.flat(def, join(path, at)));
    switch (view.kind) {
      case 'new': return { tokens: view.value === undefined ? [tok('type', view.type.toCode()), punct('()')] : [literal(view.value)], marks: [] };
      case 'get': return this.flatSteps(view.steps, path);
      case 'set': return this.glue([this.flatSteps(view.steps, path), [punct(' = ')], sub(view.def.value, 'value')]);
      case 'template': {
        const text = tok('string', `\`${view.text}\``);
        return view.def.params === undefined ? { tokens: [text], marks: [] } : this.glue([[tok('plain', 'format'), punct('('), text, punct(', ')], sub(view.def.params, 'params'), [punct(')')]]);
      }
      case 'if': {
        const parts: (Run | CodeToken[] | undefined)[] = [];
        view.def.ifs.forEach((branch, i) => {
          parts.push([...(i > 0 ? [kw(' else if')] : [kw('if')]), punct(' (')], sub(branch.condition, `ifs.${i}.condition`), [punct(') ')], sub(branch.body, `ifs.${i}.body`));
        });
        if (view.def.else !== undefined) { parts.push([kw(' else ')], sub(view.def.else, 'else')); }
        return this.glue(parts);
      }
      case 'loop': case 'switch': case 'define': case 'block': case 'other': return undefined;
      case 'lambda': return this.glue([[kw('fn '), tok('type', view.type.toCode()), punct(' => ')], sub(view.def.body, 'body')]);
      case 'flow': {
        const value = view.def.action === 'throw' ? view.def.error : view.def.value;
        if (value === undefined) { return { tokens: [kw(view.def.action)], marks: [] }; }
        return this.glue([[kw(`${view.def.action} `)], sub(value, view.def.action === 'throw' ? 'error' : 'value')]);
      }
      case 'native': return { tokens: [kw('native'), punct('('), tok('string', view.def.id), punct(')')], marks: [] };
    }
  }

  /** Does a run fit on a line at a depth? */
  private fits(run: Run, depth: number): boolean {
    return depth * INDENT + widthOf(run.tokens) <= this.#width;
  }

  /** The node as lines at a depth: on one line when it fits, wrapped otherwise. `statement` drops a block's braces. */
  lines(def: ExprDef, path: string, depth: number, statement = false): CodeLine[] {
    const flat = this.flat(def, path);
    if (flat !== undefined && this.fits(flat, depth)) { return [{ depth, ...flat }]; }
    const view = this.view(def);
    if (view === undefined) { return [{ depth, tokens: [tok('plain', '?')], marks: [this.mark(def, path)] }]; }
    const lines = this.wrapped(view, path, depth, statement);
    const [first, ...rest] = lines;
    return first === undefined ? [] : [{ ...first, marks: [this.mark(def, path), ...first.marks] }, ...rest];
  }

  /** Lines `a`, then `mid`, then lines `b`, with `b`'s first line joined onto `a`'s last. */
  private concat(a: readonly CodeLine[], mid: readonly CodeToken[], b: readonly CodeLine[]): CodeLine[] {
    const last = a.at(-1);
    const [head, ...rest] = b;
    if (last === undefined) { return [...b]; }
    const joined: CodeLine = { depth: last.depth, tokens: [...last.tokens, ...mid, ...(head?.tokens ?? [])], marks: [...last.marks, ...(head?.marks ?? [])] };
    return [...a.slice(0, -1), joined, ...rest];
  }

  private line(depth: number, tokens: CodeToken[], marks: CodeMark[] = []): CodeLine {
    return { depth, tokens, marks };
  }

  /** A body inside braces: a block's own lines, or the node as a statement. */
  private body(def: ExprDef, path: string, depth: number): CodeLine[] {
    const view = this.view(def);
    if (view?.kind === 'block') {
      const lines = view.def.lines.flatMap((l, i) => this.lines(l, join(path, `lines.${i}`), depth, true));
      const [first, ...rest] = lines;
      return first === undefined ? [] : [{ ...first, marks: [this.mark(def, path), ...first.marks] }, ...rest];
    }
    return this.lines(def, path, depth, true);
  }

  /** `head {`, the body one level in, then `}`. */
  private braced(head: CodeLine[], def: ExprDef, path: string, depth: number): CodeLine[] {
    return [...this.concat(head, [punct(' {')], []), ...this.body(def, path, depth + 1), this.line(depth, [punct('}')])];
  }

  /** Lines with a run appended to the last one. */
  private append(lines: readonly CodeLine[], run: Run): CodeLine[] {
    const last = lines.at(-1);
    return last === undefined ? [...lines] : [...lines.slice(0, -1), { depth: last.depth, tokens: [...last.tokens, ...run.tokens], marks: [...last.marks, ...run.marks] }];
  }

  /** A path whose steps fit are kept on the line; a call that doesn't fit puts one argument on each line. */
  private wrappedSteps(steps: readonly StepView[], path: string, depth: number): CodeLine[] {
    let lines: CodeLine[] = [this.line(depth, [])];
    steps.forEach((step, i) => {
      const flat = this.flatStep(step, i, path);
      const last = lines.at(-1);
      if (flat !== undefined && last !== undefined && this.fits({ tokens: [...last.tokens, ...flat.tokens], marks: [] }, last.depth)) { lines = this.append(lines, flat); return; }
      if (step.kind === 'key') { lines = this.concat(this.concat(lines, [punct('[')], this.lines(step.key, join(path, `path.${i}.key`), depth)), [punct(']')], []); return; }
      if (step.kind !== 'call') { lines = flat === undefined ? lines : this.append(lines, flat); return; }
      lines = this.concat(lines, [punct('(')], []);
      step.args.forEach(([name, arg], a) => {
        const argLines = this.concat([this.line(depth + 1, [tok('plain', `${name}: `)])], [], this.lines(arg, join(path, `path.${i}.args.${name}`), depth + 1));
        lines.push(...(a < step.args.length - 1 ? this.concat(argLines, [punct(',')], []) : argLines));
      });
      lines.push(this.line(depth, [punct(')')]));
    });
    return lines;
  }

  private wrapped(view: ExprView, path: string, depth: number, statement: boolean): CodeLine[] {
    const at = (sub: string): string => join(path, sub);
    switch (view.kind) {
      case 'new': {
        if (view.value === undefined) { return [this.line(depth, [tok('type', view.type.toCode()), punct('()')])]; }
        return JSON.stringify(view.value, null, INDENT).split('\n').map((text) => this.line(depth, [tok('plain', text)]));
      }
      case 'get': return this.wrappedSteps(view.steps, path, depth);
      case 'set': return this.concat(this.wrappedSteps(view.steps, path, depth), [punct(' = ')], this.lines(view.def.value, at('value'), depth));
      case 'template': {
        const text = this.line(depth, [tok('string', `\`${view.text}\``)]);
        if (view.def.params === undefined) { return [text]; }
        return [this.line(depth, [tok('plain', 'format'), punct('(')]), { ...text, depth: depth + 1, tokens: [...text.tokens, punct(',')] }, ...this.lines(view.def.params, at('params'), depth + 1), this.line(depth, [punct(')')])];
      }
      case 'if': {
        let lines: CodeLine[] = [];
        view.def.ifs.forEach((branch, i) => {
          const head = [...(i > 0 ? [punct('} '), kw('else if')] : [kw('if')]), punct(' (')];
          const cond = this.concat([this.line(depth, head)], [], this.lines(branch.condition, at(`ifs.${i}.condition`), depth));
          const withParen = this.concat(cond, [punct(') {')], []);
          lines = i === 0 ? withParen : [...lines.slice(0, -1), ...withParen];
          lines.push(...this.body(branch.body, at(`ifs.${i}.body`), depth + 1), this.line(depth, [punct('}')]));
        });
        if (view.def.else !== undefined) {
          lines = [...lines.slice(0, -1), this.line(depth, [punct('} '), kw('else'), punct(' {')]), ...this.body(view.def.else, at('else'), depth + 1), this.line(depth, [punct('}')])];
        }
        return lines;
      }
      case 'switch': {
        const head = this.concat([this.line(depth, [kw('switch'), punct(' (')])], [], this.lines(view.def.value, at('value'), depth));
        const lines = this.concat(head, [punct(') {')], []);
        view.def.cases.forEach((c, i) => {
          const equals = c.equals.map((e, j) => this.flat(e, at(`cases.${i}.equals.${j}`)) ?? { tokens: [tok('plain', '…')], marks: [] });
          const label = this.glue([[kw('case ')], ...equals.flatMap((e, j) => (j > 0 ? [[punct(', ')], e] : [e])), [punct(': ')]]) ?? { tokens: [], marks: [] };
          lines.push(...this.concat([this.line(depth + 1, label.tokens, label.marks)], [], this.lines(c.body, at(`cases.${i}.body`), depth + 1, true)));
        });
        if (view.def.else !== undefined) { lines.push(...this.concat([this.line(depth + 1, [kw('default'), punct(': ')])], [], this.lines(view.def.else, at('else'), depth + 1, true))); }
        lines.push(this.line(depth, [punct('}')]));
        return lines;
      }
      case 'define': {
        const inner = statement ? depth : depth + 1;
        const lines = view.def.vars.flatMap((v, i) => this.concat([this.line(inner, [kw('let '), tok('name', v.name), punct(' = ')])], [], this.lines(v.value, at(`vars.${i}.value`), inner)));
        lines.push(...this.body(view.def.body, at('body'), inner));
        return statement ? lines : [this.line(depth, [punct('{')]), ...lines, this.line(depth, [punct('}')])];
      }
      case 'block': {
        const inner = statement ? depth : depth + 1;
        const lines = view.def.lines.flatMap((l, i) => this.lines(l, at(`lines.${i}`), inner, true));
        return statement ? lines : [this.line(depth, [punct('{')]), ...lines, this.line(depth, [punct('}')])];
      }
      case 'loop': {
        const names = view.def.key === undefined && view.def.value === undefined ? [] : [tok('name', `${view.def.key ?? 'key'}, ${view.def.value ?? 'value'}`), kw(' of ')];
        const head = this.concat([this.line(depth, [kw('for'), punct(' ('), ...names])], [], this.lines(view.def.over, at('over'), depth));
        return this.braced(this.concat(head, [punct(')')], []), view.def.body, at('body'), depth);
      }
      case 'lambda': {
        let head = [this.line(depth, [kw('fn '), tok('type', view.type.toCode())])];
        if (view.def.constraint !== undefined) { head = this.concat(this.concat(head, [kw(' when'), punct(' (')], this.lines(view.def.constraint, at('constraint'), depth)), [punct(')')], []); }
        return this.braced(head, view.def.body, at('body'), depth);
      }
      case 'flow': {
        const value = view.def.action === 'throw' ? view.def.error : view.def.value;
        const head = [this.line(depth, [kw(view.def.action)])];
        return value === undefined ? head : this.concat(head, [punct(' ')], this.lines(value, at(view.def.action === 'throw' ? 'error' : 'value'), depth));
      }
      case 'native': return [this.line(depth, [kw('native'), punct('('), tok('string', view.def.id), punct(')')])];
      case 'other': {
        const parsed = this.#tools.parse(view.def);
        const code = parsed.ok ? this.#tools.code(parsed.value) : '';
        return code.split('\n').map((text) => this.line(depth, [tok('plain', text)]));
      }
    }
  }
}

/** An expression laid out as lines of code, wrapping a node only when it passes `width`. */
export function layoutExpr(def: ExprDef, tools: ExprTools, width = CODE_WIDTH): CodeLine[] {
  return new Layout(tools, width).lines(def, '', 0, true);
}

/** The plain text of laid-out lines (for tests and copying). */
export function codeText(lines: readonly CodeLine[]): string {
  return lines.map((l) => `${' '.repeat(l.depth * INDENT)}${l.tokens.map((t) => t.text).join('')}`).join('\n');
}

/** Every path a node has, for a sanity check that the layout marks each one (children by `childrenOf`). */
export function nodePaths(def: ExprDef, tools: ExprTools, path = ''): string[] {
  const parsed = tools.parse(def);
  if (!parsed.ok) { return [path]; }
  return [path, ...childrenOf(viewOf(parsed.value)).flatMap((c) => (c.def === undefined ? [] : nodePaths(c.def, tools, join(path, c.path))))];
}
