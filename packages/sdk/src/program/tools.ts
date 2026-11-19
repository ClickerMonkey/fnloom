/**
 * The authoring tools a program-writing agent (`code/make_code`, `api/make_api`) shares, on the SDK's
 * `authoringAgent` with its forced stages and progressive disclosure (product's code and api agents' table):
 *
 * - **find:** `search` lists fns by what they do (the hub's search), each named as the program calls it.
 * - **inspect:** `load` shows fns found (their signatures) and named types they use, a little at a time and never
 *   twice; `examples` shows how programs are written; `signature` declares the new fn's args and result.
 * - **draft → check → fix → save:** the kind's own draft and save (`set` and `return`), checked with `checkProgram`;
 *   `test` runs the clean draft with other args (a draft that calls fns is checked, not run).
 */
import type { ExprDef, TypeDef } from '@aeye/gin';
import { FnMode, GinTypeDef, Json, QualifiedName, type FnSearchPage, type FnSearchQuery, type TypeDefinitions } from '@harness/core';
import { z } from 'zod';
import { authoringTool, type AuthoringSession, type AuthoringTool } from '../authoring.ts';
import { programEnv } from './env.ts';
import { fnCallText, ProgramScope, storedProgramScope, type ProgramFn } from './runtime.ts';

/**
 * What an authoring session reaches through its run: the hub's search, fns and types. A draft that calls fns is checked
 * but not run while authoring (as in product): a fn's run can't call fns by name, only its declared deps.
 */
export interface ProgramHost {
  search(query: FnSearchQuery): Promise<FnSearchPage>;
  /** A fn's signature and mode, as the run's person may use it; throws with why when they can't. */
  fn(name: QualifiedName): Promise<ProgramFn>;
  /** Named types and what they reference, dependencies first. */
  types(names: readonly QualifiedName[]): Promise<TypeDefinitions>;
}

/** The new fn's signature, as `signature` declared it. */
export interface ProgramSignature {
  readonly args: TypeDef;
  readonly returns: TypeDef;
}

/** One program authoring run's state: the gin world it builds up, the host, the kind's own types and the signature. */
export class ProgramAuthoring {
  readonly program = new ProgramScope();
  readonly host: ProgramHost;
  /** The kind the agent writes (`code/program`), for the search. */
  readonly kind: QualifiedName;
  /** Named types the kind offers from the start (the api system's `api/HttpRequest`, …). */
  readonly own: readonly QualifiedName[];
  /** How programs of this kind are written, with worked examples (`examples`). */
  readonly guide: string;
  #signature: ProgramSignature | undefined;

  constructor(input: { host: ProgramHost; kind: QualifiedName; own?: readonly QualifiedName[]; guide: string; signature?: ProgramSignature | undefined }) {
    this.host = input.host;
    this.kind = input.kind;
    this.own = input.own ?? [];
    this.guide = input.guide;
    this.#signature = input.signature;
    this.program.addOwn(this.own);
  }

  get signature(): ProgramSignature | undefined {
    return this.#signature;
  }

  declare(signature: ProgramSignature): void {
    this.#signature = signature;
  }

  /** Load what a stored fn's programs use (the fns they call, the types they name), to change it as it stands. */
  async preload(stored: { readonly types: readonly TypeDef[]; readonly programs: readonly ExprDef[] }): Promise<void> {
    const host = this.host;
    await storedProgramScope(stored, { types: (names) => host.types(names), fn: (name) => host.fn(name).catch(() => undefined) }, this.program);
  }

  /** Load named types into the session; the ones newly bound. */
  async loadTypes(names: readonly QualifiedName[]): Promise<string[]> {
    const wanted = names.filter((name) => !this.program.resolves(name));
    return wanted.length === 0 ? [] : this.program.addTypes((await this.host.types(wanted)).types);
  }
}

/** A session of a program authoring agent. */
export type ProgramSession<S extends ProgramAuthoring, D> = AuthoringSession<S, D>;

/** Type definitions printed, within the budget; the rest listed by name for a later load. */
function printTypes(program: ProgramScope, names: readonly string[]): string[] {
  const budget = programEnv.get('HARNESS_PROGRAM_TYPE_CHARS');
  const lines: string[] = [];
  const later: string[] = [];
  let used = 0;
  for (const name of names) {
    const code = program.typeCode(name);
    if (code === undefined) continue;
    if (lines.length > 0 && used + code.length > budget) { later.push(name); continue; }
    lines.push(code);
    used += code.length;
  }
  return later.length === 0 ? lines : [...lines, `More types to load when you need them: ${later.join(', ')}.`];
}

/** The level names disclosure keeps: fns and named types. */
const FN = 'fn';
const TYPE = 'type';

/** `search`: fns by what they do, named as a program calls them. */
function searchTool<S extends ProgramAuthoring, D>(): AuthoringTool<S, D> {
  return authoringTool<S, D, { text: string }>({
    name: 'search',
    stage: 'find',
    description: 'Search the fns a program may call (and fns of this kind that may already do it) by what they do, in plain words.',
    instructions: 'Call it first with what the program needs, in a few words; call it again for each other piece. A fn of this kind that already does the whole request can be reused.',
    schema: z.object({ text: z.string().min(1).describe('What the fn should do, in plain words.') }),
    async call({ text }, session) {
      const state = session.state;
      const page = await state.host.search({ text, items: ['fn'], limit: programEnv.get('HARNESS_PROGRAM_SEARCH_LIMIT') });
      session.disclosure.markSearched(FN);
      session.disclosure.markAware(FN, page.items.map((hit) => hit.name));
      session.disclosure.markAware(TYPE, state.own);
      const own = page.items.filter((hit) => hit.kind === state.kind);
      return [
        page.items.length === 0 ? 'No fn fits.' : 'Fns that may fit (load the ones you call):',
        ...page.items.map((hit) => `- ${hit.name}${hit.signature === undefined ? '' : ` ${hit.signature}`} (${hit.mode ?? 'mode unknown'}): ${hit.description}${hit.available ? '' : ` [unavailable: ${hit.blocked?.reason ?? 'not now'}]`}`),
        own.length === 0 ? '' : `A ${state.kind} fn above that already does the whole request can be the answer: call reuse with its name.`,
        state.own.length === 0 ? '' : `Types of this kind you may load: ${state.own.join(', ')}.`,
      ].filter((line) => line !== '').join('\n');
    },
  });
}

/** `load`: fns found (their signatures, as the program calls them) and named types, only what is asked, never twice. */
function loadTool<S extends ProgramAuthoring, D>(): AuthoringTool<S, D> {
  return authoringTool<S, D, { fns?: string[] | undefined; types?: string[] | undefined }>({
    name: 'load',
    stage: 'inspect',
    description: 'Show fns search listed (how a program calls each, its args and result) and named types in full. Load only what the program uses.',
    instructions: 'Load each fn the program will call before you write it: only loaded fns can be called. Load a type when you build a value of it.',
    schema: z.object({
      fns: z.array(z.string().min(1)).optional().describe('Fns as search listed them (`system/name`).'),
      types: z.array(z.string().min(1)).optional().describe('Named types as a load or search listed them.'),
    }),
    when: (session) => session.disclosure.awareUnloaded(FN).length > 0 || session.disclosure.awareUnloaded(TYPE).length > 0,
    async call({ fns = [], types = [] }, session) {
      const { disclosure } = session;
      const state = session.state;
      const unseen = [...fns, ...types].filter((name) => !disclosure.awareUnloaded(FN).includes(name) && !disclosure.awareUnloaded(TYPE).includes(name) && !disclosure.isLoaded(FN, name) && !disclosure.isLoaded(TYPE, name));
      if (unseen.length > 0) { throw new Error(`${unseen.join(', ')} ${unseen.length === 1 ? 'was' : 'were'} not listed: search first, then load what it lists.`); }
      const lines: string[] = [];
      const referenced: QualifiedName[] = [];
      for (const name of fns) {
        if (disclosure.isLoaded(FN, name)) { lines.push(`${name} is already loaded.`); continue; }
        const fn = await state.host.fn(nameOf(name));
        const missing = [...state.program.unresolved(fn.args), ...state.program.unresolved(fn.returns)];
        referenced.push(...missing.map(nameOf));
        await state.loadTypes(missing.map(nameOf));
        state.program.addFn(fn);
        disclosure.markLoaded(FN, [name]);
        lines.push(`${state.program.signature(fnCallText(fn.name), fn.args, fn.returns)} (${fn.mode ?? 'mode unknown'}): ${fn.description}`);
      }
      const asked = types.map(nameOf);
      const added = [...await state.loadTypes(asked), ...asked.filter((name) => state.program.resolves(name) && !disclosure.isLoaded(TYPE, name))];
      const shown = [...new Set([...referenced, ...added])].filter((name) => !disclosure.isLoaded(TYPE, name));
      disclosure.markLoaded(TYPE, shown);
      const missingTypes = asked.filter((name) => !state.program.resolves(name));
      return [
        ...lines,
        ...(shown.length === 0 ? [] : ['Types:', ...printTypes(state.program, shown)]),
        missingTypes.length === 0 ? '' : `No type ${missingTypes.join(', ')}.`,
      ].filter((line) => line !== '').join('\n');
    },
  });
}

/** A name the model wrote, as a qualified name; throws in words when it isn't one. */
function nameOf(name: string): QualifiedName {
  const parsed = QualifiedName.safeParse(name);
  if (!parsed.success) throw new Error(`${name} is not a qualified name (\`system/name\`).`);
  return parsed.data;
}

/** `examples`: how programs of this kind are written, with worked examples. */
function examplesTool<S extends ProgramAuthoring, D>(): AuthoringTool<S, D> {
  return authoringTool<S, D, Record<string, never>>({
    name: 'examples',
    stage: 'inspect',
    description: 'Show how a program is written (the expression kinds, reading args, calling a loaded fn) with worked examples.',
    instructions: 'Call it once before your first draft.',
    schema: z.object({}),
    when: (session) => !session.disclosure.isLoaded('docs', 'examples'),
    call(_input, session) {
      session.disclosure.markLoaded('docs', ['examples']);
      return session.state.guide;
    },
  });
}

/** `signature`: the new fn's args (an obj type) and result type; the scope its program will see. */
function signatureTool<S extends ProgramAuthoring, D>(): AuthoringTool<S, D> {
  return authoringTool<S, D, { args: TypeDef; returns: TypeDef }>({
    name: 'signature',
    stage: 'inspect',
    description: 'Declare the new fn\'s args (an obj type: each arg a prop, an optional arg wrapped in optional) and what it returns. The draft is checked against it.',
    instructions: 'Declare it before the draft, and again whenever the args or the result change. Use only built-in types and loaded ones.',
    schema: (session) => {
      const { Type } = session.state.program.schemas();
      return z.object({ args: Type.pipe(GinTypeDef).describe('An obj type: {"name":"obj","props":{"amount":{"type":{"name":"num"}}}}.'), returns: Type.pipe(GinTypeDef).describe('The result type.') });
    },
    async call({ args, returns }, session) {
      const state = session.state;
      if (args.name !== 'obj') { throw new Error('args must be an obj type: {"name":"obj","props":{…}}, with {} for none.'); }
      const missing = [...state.program.unresolved(args), ...state.program.unresolved(returns)];
      const loaded = await state.loadTypes(missing.map(nameOf));
      const still = missing.filter((name) => !state.program.resolves(name));
      if (still.length > 0) { throw new Error(`Unknown types ${still.join(', ')}: load them or use built-in types.`); }
      try { state.program.parse(args); state.program.parse(returns); } catch (error) {
        throw new Error(`The signature doesn't parse: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      state.declare({ args, returns });
      session.disclosure.markLoaded(TYPE, loaded);
      const fns = state.program.fns;
      return [
        `Declared: ${state.program.signature('this', args, returns)}`,
        `The program reads args.<name>${fns.length === 0 ? ' and calls no fn (none is loaded)' : ` and may call ${fns.map((fn) => fnCallText(fn.name)).join(', ')}`}.`,
        ...(loaded.length === 0 ? [] : ['Types:', ...printTypes(state.program, loaded)]),
      ].join('\n');
    },
  });
}

/** The find and inspect tools every program authoring agent has. */
export function programTools<S extends ProgramAuthoring, D>(): Array<AuthoringTool<S, D>> {
  return [searchTool<S, D>(), loadTool<S, D>(), examplesTool<S, D>(), signatureTool<S, D>()];
}

/**
 * `test`: run the clean draft with other args and show what it gives, offered once a draft checked clean. `run` is
 * the kind's own test run (a code program; an api request materialized, sent only when it is a GET).
 */
export function testTool<S extends ProgramAuthoring, D>(run: (draft: D, args: Record<string, Json>, session: ProgramSession<S, D>) => Promise<string>): AuthoringTool<S, D> {
  return authoringTool<S, D, { args: Record<string, Json> }>({
    name: 'test',
    stage: 'draft',
    description: 'Run the draft that checked clean with these args and show what it gives.',
    instructions: 'Use it to try edge cases (an empty list, a missing optional arg) before you save.',
    schema: z.object({ args: z.record(z.string(), Json).describe('A value for each arg, by name.') }),
    when: (session) => session.lastCheck !== undefined && session.lastCheck.problems.length === 0,
    async call({ args }, session) {
      const draft = session.draft;
      if (draft === undefined) throw new Error('There is no draft to test.');
      return run(draft, args, session);
    },
  });
}

/** A fn's mode from a search hit, when the hub gave one. */
export function modeOf(page: FnSearchPage, name: QualifiedName): FnMode | undefined {
  const hit = page.items.find((item) => item.name === name);
  return hit?.mode === undefined ? undefined : FnMode.parse(hit.mode);
}

/** Text cut to the preview budget. */
export function previewText(value: Json): string {
  const text = JSON.stringify(value);
  const max = programEnv.get('HARNESS_PROGRAM_PREVIEW_CHARS');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
