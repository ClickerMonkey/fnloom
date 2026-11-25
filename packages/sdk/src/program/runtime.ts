/**
 * The gin program runtime shared by the `code` and `api` systems (product's `kinds/program.ts`, ported; build 9
 * design §0.7): one session artifact (`ProgramScope`: the named types and fns a program may use, bound in a gin scope
 * overlay on `g`), the validation pipeline (`checkProgram`: parse, the closed-world type check, gin's own analysis over
 * a scope of `args`, `fns` and what the kind owns, the result-type check with a paste-ready spelling, and the safety
 * rules), the scope-read walk (`programFacts`: which fns a program calls) and execution (`runProgram`: `fns.<system>.
 * <name>(…)` calls go through the caller's `call`, within the limits of `programEnv`).
 *
 * A program reads its args as `args.<name>` and calls a fn as `fns.<system>.<name>(…)` (an instance's fn as
 * `fns.<system>.<instance>.<name>(…)`), a path that ends in a call step. Values cross a fn call as logical JSON: the
 * args are encoded from gin, and the answer is parsed back through the callee's declared return type.
 *
 * **Limits.** A run is given gin's run signal: every loop round and fn call is a checkpoint, so the deadline
 * (`HARNESS_PROGRAM_TIMEOUT`) or the caller's cancel stops the engine there, and a long run yields to the event loop
 * between slices, so other runs and requests on the same system go on meanwhile. On top of that, static rules keep
 * programs plain: no while-loops (a loop over a `bool`, re-evaluated each round), no loop over a value of unknown type,
 * no `recurse`, a complexity cap; and at run time a cap on fn calls.
 */
import { createEngine, typeReferences, val, type BuildSchemasOverrides, type Engine, type Expr, type ExprDef, type LocalScope, type Registry, type Type, type TypeDef, type Value } from '@aeye/gin';
import { harnessRegistry, Json, QualifiedName, isGinExprDef, isGinTypeDef, type FnMode, type HarnessGrammarArgs } from '@harness/core';
import { g } from '../gin.ts';
import { programEnv } from './env.ts';

/** The name a program reads its args by. */
export const ARGS_SCOPE = 'args';
/** The name a program calls fns through. */
export const FNS_SCOPE = 'fns';

/** A fn a program may call: its name, what it does, its signature and, when the hub said, its mode. */
export interface ProgramFn {
  readonly name: QualifiedName;
  readonly description: string;
  readonly args: TypeDef;
  readonly returns: TypeDef;
  /** A test run while authoring calls only fns that read. */
  readonly mode?: FnMode | undefined;
}

/** A program run stopped: a limit was reached, or a call or the program itself failed. */
export class ProgramError extends Error {
  /** `limit`: a limit of `programEnv` stopped it; `failed`: the program or a fn it called threw. */
  readonly reason: 'limit' | 'failed';

  constructor(message: string, reason: 'limit' | 'failed') {
    super(message);
    this.name = 'ProgramError';
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path a qualified fn name takes under `fns`: `database/main.orders` → `database`, `main`, `orders`. */
export function fnPath(name: QualifiedName): string[] {
  const slash = name.indexOf('/');
  return [name.slice(0, slash), ...name.slice(slash + 1).split('.')];
}

/** How a program calls a fn, as the agent writes it: `fns.database.main.orders(…)`. */
export function fnCallText(name: QualifiedName): string {
  return [FNS_SCOPE, ...fnPath(name)].join('.');
}

/**
 * How an authored program's grammar is bound: `newStrict`, so a `new` expression's value is typed by the type it names
 * (plain fields take their value, composite fields an Expr) and a strict tool call is told each value's shape rather
 * than "any JSON".
 */
export const PROGRAM_GRAMMAR: BuildSchemasOverrides = { newStrict: true };

/** A named type's definition, as the hub sends it (`TypeDefinitions.types`) or `typeClosure` gathers it. */
export interface NamedTypeDef {
  readonly name: string;
  readonly def: TypeDef;
}

/** A nested tree of fns by path segment, as the `fns` scope object is built. */
interface FnTree {
  readonly fns: Map<string, ProgramFn>;
  readonly branches: Map<string, FnTree>;
}

/**
 * One authoring session's (or one run's) gin world: the named types it has loaded, bound in a scope overlay on `g` so
 * they resolve for it alone and still serialize by name, and the fns its programs may call.
 */
export class ProgramScope {
  readonly scope: LocalScope;
  readonly engine: Engine;
  readonly #types = new Map<string, TypeDef>();
  readonly #fns = new Map<QualifiedName, ProgramFn>();
  /** Every named type an authored program may spell, in the order bound (dependencies first), for `registry`. */
  readonly #named: NamedTypeDef[] = [];
  #registry: Registry | undefined;

  constructor() {
    this.scope = g.scope();
    this.engine = createEngine(g);
  }

  /** Bind named type definitions (dependencies first, as the hub sends them); the names newly bound. */
  addTypes(types: readonly NamedTypeDef[]): string[] {
    const added: string[] = [];
    for (const record of types) {
      if (this.scope.lookup(record.name) !== undefined) continue;
      this.scope.bind(record.name, this.scope.parse(record.def));
      this.#types.set(record.name, record.def);
      this.#named.push(record);
      added.push(record.name);
    }
    return added;
  }

  /**
   * Offer named types registered in `g` (a contract's own, such as `api/HttpRequest`) to authored programs, in
   * dependency order: they resolve already, and this adds them to the typed schemas the agent writes against.
   */
  addOwn(names: readonly string[]): void {
    for (const name of names) {
      const type = g.lookup(name);
      if (type === undefined || this.#named.some((named) => named.name === name)) continue;
      this.#named.push({ name, def: type.toJSON() });
    }
  }

  /**
   * The registry an authored program is typed by: the built-ins and the named types this scope offers, in a registry
   * of their own, so a program may spell only those. Registering a newly bound type bumps its version, which is what
   * the grammar's binds are keyed by.
   */
  registry(): Registry {
    const registry = this.#registry ??= harnessRegistry();
    for (const { name, def } of this.#named) {
      if (registry.lookup(name) !== undefined) continue;
      const type = registry.parse(def);
      registry.register(type.name === name ? type : registry.extend(type, { name }));
    }
    return registry;
  }

  /**
   * `HarnessGrammar`'s bind args for a program of this scope (`Bundle.bind(...program.grammar())`): its registry, and
   * `PROGRAM_GRAMMAR`. Fn names stay plain (a program calls fns by path, not by a fn-name text).
   */
  grammar(): HarnessGrammarArgs {
    return [this.registry(), undefined, PROGRAM_GRAMMAR];
  }

  /** Whether a type name resolves here (a built-in, a type registered in `g`, or one loaded). */
  resolves(name: string): boolean {
    return this.scope.lookup(name) !== undefined;
  }

  /** The named types a definition refers to that don't resolve here yet. */
  unresolved(def: TypeDef): string[] {
    return typeReferences(def, g).refs.filter((name) => !this.resolves(name));
  }

  /** A type as code, for the agent: a named type's definition, else its code. */
  typeCode(name: string): string | undefined {
    const type = this.scope.lookup(name);
    if (type === undefined) return undefined;
    const def = this.#types.get(name);
    return def === undefined ? type.toCodeDefinition() : this.scope.parse(def).toCodeDefinition();
  }

  parse(def: TypeDef): Type {
    return this.scope.parse(def);
  }

  parseExpr(def: ExprDef): Expr {
    return g.parseExpr(def, this.scope);
  }

  addFn(fn: ProgramFn): void {
    this.#fns.set(fn.name, fn);
  }

  fn(name: QualifiedName): ProgramFn | undefined {
    return this.#fns.get(name);
  }

  get fns(): ProgramFn[] {
    return [...this.#fns.values()];
  }

  /** The fn a path under `fns` names (its segments after `fns`), when one is loaded. */
  fnAt(path: readonly string[]): ProgramFn | undefined {
    return this.fns.find((fn) => { const own = fnPath(fn.name); return own.length === path.length && own.every((segment, index) => segment === path[index]); });
  }

  /** `name(a: num, b?: text) → returns`, for the agent. */
  signature(name: string, args: TypeDef, returns: TypeDef): string {
    const props = isRecord(args.props) ? Object.entries(args.props) : [];
    const shown = props.map(([key, prop]) => {
      const optional = prop.type.name === 'optional';
      const inner = optional ? (prop.type.generic?.['T'] ?? prop.type) : prop.type;
      return `${key}${optional ? '?' : ''}: ${this.parse(inner).toCode(g)}`;
    });
    return `${name}(${shown.join(', ')}) → ${this.parse(returns).toCode(g)}`;
  }

  /** The `fns` scope type over these fns (every loaded one when absent); `undefined` when there are none. */
  fnsType(names?: readonly QualifiedName[]): Type | undefined {
    const tree = this.#tree(names);
    return tree === undefined ? undefined : this.#treeType(tree);
  }

  /** The `fns` scope value over these fns, each calling `call` with logical JSON args and parsing its answer back. */
  fnsValue(names: readonly QualifiedName[], call: (fn: QualifiedName, args: Json) => Promise<Json>): Value | undefined {
    const tree = this.#tree(names);
    return tree === undefined ? undefined : this.#treeValue(tree, call);
  }

  #tree(names?: readonly QualifiedName[]): FnTree | undefined {
    const chosen = names === undefined ? this.fns : names.map((name) => this.#fns.get(name)).filter((fn): fn is ProgramFn => fn !== undefined);
    if (chosen.length === 0) return undefined;
    const root: FnTree = { fns: new Map(), branches: new Map() };
    for (const fn of chosen) {
      const path = fnPath(fn.name);
      let at = root;
      for (const segment of path.slice(0, -1)) {
        const next = at.branches.get(segment) ?? { fns: new Map<string, ProgramFn>(), branches: new Map<string, FnTree>() };
        at.branches.set(segment, next);
        at = next;
      }
      at.fns.set(path[path.length - 1] ?? fn.name, fn);
    }
    return root;
  }

  #fnType(fn: ProgramFn): Type {
    return this.parse({ name: 'fn', call: { args: fn.args, returns: fn.returns } });
  }

  #treeType(tree: FnTree): Type {
    const fields: Record<string, { type: Type }> = {};
    for (const [segment, branch] of tree.branches) fields[segment] = { type: this.#treeType(branch) };
    for (const [segment, fn] of tree.fns) fields[segment] = { type: this.#fnType(fn) };
    return g.obj(fields);
  }

  #treeValue(tree: FnTree, call: (fn: QualifiedName, args: Json) => Promise<Json>): Value {
    const raw: Record<string, Value> = {};
    for (const [segment, branch] of tree.branches) raw[segment] = this.#treeValue(branch, call);
    for (const [segment, fn] of tree.fns) {
      const returns = this.parse(fn.returns);
      raw[segment] = val(this.#fnType(fn), async (args: Value): Promise<Value> => returns.parse(await call(fn.name, Json.parse(args.encodeLogical()))));
    }
    return val(this.#treeType(tree), raw);
  }
}

/** The args type a lambda's body sees, when its type parses. */
function lambdaArgs(program: ProgramScope, def: TypeDef): Type | undefined {
  try { return program.parse(def).call()?.args; } catch { return undefined; }
}

/** What the static walk found: the fns a program calls, and what breaks the rules. */
export interface ProgramFacts {
  readonly calls: QualifiedName[];
  readonly problems: string[];
}

/** The types of the names a program sees, as gin's analysis takes them. */
export type ProgramLocals = Map<string, Type>;

/**
 * The scope-read walk: every `fns.…(…)` call (each must be a loaded fn, called in place), and the safety rules (no
 * while-loop, no loop over a value of unknown type, no `recurse`, never changing `args` or `fns`). Locals are followed
 * through `define`, `loop` and `lambda` so a loop's type is judged where it is.
 */
export function programFacts(program: ProgramScope, def: ExprDef, locals: ProgramLocals): ProgramFacts {
  const calls = new Set<QualifiedName>();
  const problems: string[] = [];
  const typeOf = (node: unknown, scope: ProgramLocals): Type | undefined => {
    if (!isGinExprDef(node)) return undefined;
    try { return program.engine.typeOf(program.parseExpr(node), scope); } catch { return undefined; }
  };
  const path = (node: Record<string, unknown>, writes: boolean): void => {
    const steps = Array.isArray(node['path']) ? node['path'] : [];
    const first: unknown = steps[0];
    const head = isRecord(first) && typeof first['prop'] === 'string' ? first['prop'] : undefined;
    if (head === 'recurse') { problems.push('A program can\'t call itself (`recurse`): write a loop over a list instead.'); }
    if (head !== FNS_SCOPE) {
      if (writes && head === ARGS_SCOPE) { problems.push('A program can\'t change `args`: define a local with `define` instead.'); }
      return;
    }
    if (writes) { problems.push('A program can\'t change `fns`.'); return; }
    const segments: string[] = [];
    let index = 1;
    for (; index < steps.length; index += 1) {
      const step: unknown = steps[index];
      if (!isRecord(step) || typeof step['prop'] !== 'string' || 'args' in step) break;
      segments.push(step['prop']);
      if (program.fnAt(segments) !== undefined) { index += 1; break; }
    }
    const fn = program.fnAt(segments);
    const shown = [FNS_SCOPE, ...segments].join('.');
    if (fn === undefined) { problems.push(`${shown} is not a loaded fn: load it first, then call it as fns.<system>.<name>({ … }).`); return; }
    const next: unknown = steps[index];
    if (!isRecord(next) || !('args' in next)) { problems.push(`${shown} must be called in place: the step after it is the call, { "args": { … } }.`); return; }
    calls.add(fn.name);
  };
  const walk = (node: unknown, scope: ProgramLocals): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item, scope); return; }
    if (!isRecord(node)) return;
    switch (node['kind']) {
      case 'get': path(node, false); break;
      case 'set': path(node, true); break;
      case 'define': {
        const inner = new Map(scope);
        for (const variable of Array.isArray(node['vars']) ? node['vars'] : []) {
          if (!isRecord(variable)) continue;
          walk(variable['value'], inner);
          const type = typeOf(variable['value'], inner);
          if (typeof variable['name'] === 'string' && type !== undefined) inner.set(variable['name'], type);
        }
        walk(node['body'], inner);
        return;
      }
      case 'loop': {
        walk(node['over'], scope);
        const over = typeOf(node['over'], scope);
        const access = over?.get();
        if (access?.loopDynamic === true) { problems.push('A loop over a bool (a while-loop) can\'t be bounded: loop over a list instead.'); }
        else if (over === undefined || access === undefined) { problems.push(`A loop must go over a value whose type is known (a list, a map, a num): this one is ${over?.toCode(g) ?? 'unknown'}.`); }
        const inner = new Map(scope);
        if (access !== undefined) {
          inner.set(typeof node['key'] === 'string' ? node['key'] : 'key', access.key);
          inner.set(typeof node['value'] === 'string' ? node['value'] : 'value', access.value);
        }
        walk(node['body'], inner);
        walk(node['parallel'], scope);
        return;
      }
      case 'lambda': {
        const inner = new Map(scope);
        const args = isGinTypeDef(node['type']) ? lambdaArgs(program, node['type']) : undefined;
        if (args !== undefined) inner.set(ARGS_SCOPE, args);
        walk(node['body'], inner);
        walk(node['constraint'], inner);
        return;
      }
      default: break;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'kind' || key === 'type') continue;
      walk(value, scope);
    }
  };
  walk(def, locals);
  return { calls: [...calls], problems };
}

/** What `checkProgram` found: whether it is clean, its problems in words, the type it produces and the fns it calls. */
export interface ProgramCheck {
  readonly problems: string[];
  /** The program as gin code, for the agent and the fn page. */
  readonly code?: string | undefined;
  /** The type it produces, as code. */
  readonly produces?: string | undefined;
  readonly calls: QualifiedName[];
  /** The parsed program, when it parsed. */
  readonly expr?: Expr | undefined;
}

/** What a program is checked against: its args type, the type its result must fit, and names the kind owns. */
export interface ProgramExpectations {
  readonly args: TypeDef;
  readonly returns: TypeDef;
  /** Names the kind binds besides `args` and `fns` (the api output program's `response`). */
  readonly owned?: ReadonlyMap<string, Type> | undefined;
  /** Where the problems are, for the agent (`request`, `output`); absent for a lone program. */
  readonly label?: string | undefined;
}

/** The locals a program sees: `args`, the loaded fns as `fns`, then what the kind owns. */
export function programLocals(program: ProgramScope, expect: Pick<ProgramExpectations, 'args' | 'owned'>): ProgramLocals {
  const locals: ProgramLocals = new Map([[ARGS_SCOPE, program.parse(expect.args)]]);
  const fns = program.fnsType();
  if (fns !== undefined) locals.set(FNS_SCOPE, fns);
  for (const [name, type] of expect.owned ?? []) locals.set(name, type);
  return locals;
}

/**
 * The validation pipeline: unknown type names, the parse, the static walk, gin's analysis over `programLocals`, the
 * complexity cap, and whether the result fits `returns` (with the type it produces, spelled to paste into the
 * signature when that is what is wrong). Never throws.
 */
export function checkProgram(program: ProgramScope, def: ExprDef, expect: ProgramExpectations): ProgramCheck {
  const at = expect.label === undefined ? '' : `${expect.label}: `;
  const unknown = [...new Set(typeNamesIn(def).filter((name) => !program.resolves(name)))];
  if (unknown.length > 0) return { problems: unknown.map((name) => `${at}the type ${name} is not loaded: load it first, or spell a built-in type.`), calls: [] };
  let expr: Expr;
  try { expr = program.parseExpr(def); } catch (error) {
    return { problems: [`${at}it doesn't parse: ${error instanceof Error ? error.message : String(error)}`], calls: [] };
  }
  const locals = programLocals(program, expect);
  const facts = programFacts(program, def, locals);
  const found = program.engine.validate(expr, locals);
  const produced = program.engine.typeOf(expr, locals);
  const returns = program.parse(expect.returns);
  if (!returns.compatible(produced)) {
    found.push('expr.type', `It produces \`${produced.toCode(g)}\` but \`${returns.toCode(g)}\` is expected. If the program is right, its type is ${JSON.stringify(produced.toJSON())}.`);
  }
  const max = programEnv.get('HARNESS_PROGRAM_MAX_COMPLEXITY');
  const complexity = expr.complexity();
  const code = program.engine.toGinCode(expr);
  const errors = found.list.filter((problem) => problem.severity === 'error');
  const problems = [
    ...facts.problems.map((problem) => `${at}${problem}`),
    ...(errors.length === 0 ? [] : [`${at}${code.formatProblems(found)}`]),
    ...(complexity > max ? [`${at}it is too complex (${String(complexity)}, the most is ${String(max)}): split the work into smaller fns.`] : []),
  ];
  return { problems, code: code.toString(), produces: produced.toCode(g), calls: facts.calls, expr };
}

/** Every named type a program spells (in `new`, `define` and `lambda` types and call generics). */
export function typeNamesIn(def: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' && isGinTypeDef(value)) { names.push(...typeReferences(value, g).refs); continue; }
      if (key === 'generic' && isRecord(value)) {
        for (const type of Object.values(value)) if (isGinTypeDef(type)) names.push(...typeReferences(type, g).refs);
        continue;
      }
      visit(value);
    }
  };
  visit(def);
  return names;
}

/**
 * The fns a stored program calls, read off its `fns.…` paths before any fn is known: a fn is called in place, so the
 * names before a path's call step are its whole qualified name (`fns.database.main.orders(…)` →
 * `database/main.orders`). The kind looks each up (one lookup per fn, none for a name that can't be one) and loads the
 * ones that exist; the static walk then checks them.
 */
export function fnCandidates(def: unknown): QualifiedName[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!isRecord(node)) return;
    const steps = node['kind'] === 'get' && Array.isArray(node['path']) ? node['path'] : [];
    const names: string[] = [];
    let called = false;
    for (const step of steps) {
      if (!isRecord(step)) break;
      if ('args' in step) { called = true; break; }
      if (typeof step['prop'] !== 'string') break;
      names.push(step['prop']);
    }
    if (called && names[0] === FNS_SCOPE && names.length >= 3) found.add(`${names[1] ?? ''}/${names.slice(2).join('.')}`);
    for (const value of Object.values(node)) visit(value);
  };
  visit(def);
  return [...found].map((name) => QualifiedName.safeParse(name)).filter((parsed) => parsed.success).map((parsed) => parsed.data);
}

/**
 * The definitions of named types and every type they reference, dependencies first, from a lookup of one name at a
 * time (a kind's `KindCheckCtx.type`): what `ProgramScope.addTypes` takes.
 */
export async function typeClosure(names: readonly string[], lookup: (name: QualifiedName) => Promise<TypeDef | undefined>): Promise<{ types: NamedTypeDef[]; missing: QualifiedName[] }> {
  const types: NamedTypeDef[] = [];
  const missing: QualifiedName[] = [];
  const seen = new Set<string>();
  const visit = async (raw: string): Promise<void> => {
    if (seen.has(raw)) return;
    seen.add(raw);
    const parsed = QualifiedName.safeParse(raw);
    if (!parsed.success || g.lookup(raw) !== undefined) return;
    const def = await lookup(parsed.data);
    if (def === undefined) { missing.push(parsed.data); return; }
    for (const ref of typeReferences(def, g).refs) await visit(ref);
    types.push({ name: parsed.data, def });
  };
  for (const name of names) await visit(name);
  return { types, missing };
}

/** Where a stored program's world comes from: named types (with what they reference) and fns, by name. */
export interface ProgramLookups {
  types(names: readonly QualifiedName[]): Promise<{ readonly types: readonly NamedTypeDef[] }>;
  /** A fn's signature; `undefined` when there is none by that name (or it may not be seen). */
  fn(name: QualifiedName): Promise<ProgramFn | undefined>;
}

/**
 * The gin world a stored payload's programs run in, as a kind checks, describes or runs it: the fns its programs may
 * call (each `fnCandidates` name that exists) and every named type its signature, its programs and those fns use.
 * Given `program`, it fills that one (an authoring session changing a stored fn).
 */
export async function storedProgramScope(stored: { readonly types: readonly TypeDef[]; readonly programs: readonly ExprDef[] }, lookups: ProgramLookups, program: ProgramScope = new ProgramScope()): Promise<ProgramScope> {
  const fns = await Promise.all([...new Set(stored.programs.flatMap((def) => fnCandidates(def)))].map((name) => lookups.fn(name)));
  for (const fn of fns) if (fn !== undefined) program.addFn(fn);
  const names = [
    ...stored.types.flatMap((def) => typeReferences(def, g).refs),
    ...stored.programs.flatMap((def) => typeNamesIn(def)),
    ...program.fns.flatMap((fn) => [...typeReferences(fn.args, g).refs, ...typeReferences(fn.returns, g).refs]),
  ].filter((name) => !program.resolves(name));
  const wanted = [...new Set(names)].flatMap((name) => { const parsed = QualifiedName.safeParse(name); return parsed.success ? [parsed.data] : []; });
  if (wanted.length > 0) program.addTypes((await lookups.types(wanted)).types);
  return program;
}

/** One run of a checked program. */
export interface ProgramRun {
  readonly program: ProgramScope;
  readonly expr: Expr;
  readonly args: TypeDef;
  readonly returns: TypeDef;
  /** The fns it calls (`ProgramCheck.calls`); each must be in `program`. */
  readonly calls: readonly QualifiedName[];
  /** Values for the names the kind owns. */
  readonly owned?: Readonly<Record<string, Value>> | undefined;
  /** Call a fn with logical JSON args; its answer as JSON. */
  readonly call: (fn: QualifiedName, args: Json) => Promise<Json>;
  readonly signal?: AbortSignal | undefined;
}

/** Run a checked program with these args: its result as logical JSON, checked against `returns`. */
export async function runProgram(run: ProgramRun, input: Json): Promise<Json> {
  const timeout = programEnv.get('HARNESS_PROGRAM_TIMEOUT');
  const maxCalls = programEnv.get('HARNESS_PROGRAM_MAX_CALLS');
  const deadline = AbortSignal.timeout(timeout);
  const signal = run.signal === undefined ? deadline : AbortSignal.any([run.signal, deadline]);
  const limitError = (): ProgramError => new ProgramError(deadline.aborted ? `The program ran past ${String(timeout)} ms.` : 'The run was stopped.', 'limit');
  let made = 0;
  const fns = run.program.fnsValue(run.calls, async (fn, args) => {
    if (signal.aborted) throw limitError();
    made += 1;
    if (made > maxCalls) throw new ProgramError(`The program made more than ${String(maxCalls)} fn calls.`, 'limit');
    return run.call(fn, args);
  });
  let argsValue: Value;
  try { argsValue = run.program.parse(run.args).parse(input); } catch (error) {
    throw new ProgramError(`The args don't fit: ${error instanceof Error ? error.message : String(error)}`, 'failed');
  }
  const extras: Record<string, Value> = { [ARGS_SCOPE]: argsValue, ...(fns === undefined ? {} : { [FNS_SCOPE]: fns }), ...run.owned };
  // the engine stops itself at its next loop round or fn call once `signal` aborts; the race answers at once even when
  // the run is waiting on a fn call that hasn't come back
  let cleanup = (): void => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = () => { reject(limitError()); };
    if (signal.aborted) { stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    cleanup = () => { signal.removeEventListener('abort', stop); };
  });
  const running = run.program.engine.run(run.expr, extras, { signal, slice: programEnv.get('HARNESS_PROGRAM_SLICE') });
  // a run the race left behind still settles (it stops at its next checkpoint); its outcome is already answered
  void running.catch(() => undefined);
  let out: Value;
  try {
    out = await Promise.race([running, stopped]);
  } catch (error) {
    if (error instanceof ProgramError) throw error;
    if (signal.aborted) throw limitError();
    throw new ProgramError(error instanceof Error ? error.message : String(error), 'failed');
  } finally {
    cleanup();
  }
  try {
    return Json.parse(run.program.parse(run.returns).parse(out.encodeLogical()).encodeLogical());
  } catch (error) {
    throw new ProgramError(`The result doesn't fit the declared type: ${error instanceof Error ? error.message : String(error)}`, 'failed');
  }
}
