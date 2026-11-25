/**
 * The chat modes. `tools` is build 1's strict mode: every selected fn at `signature` or `full` is a native tool, and
 * `listed` fns are a `<more_fns>` list the model can load. `static` always sends the same six tools (`find`, which is
 * `hub/fns_search`, `find_ctx`, which is `hub/ctx_search`, `inspect`, `load`, `unload`, the hub fns of those names, and `run`, which is not a fn: a call of it
 * becomes a run of the fn it names, its args checked against that fn's type first), and shows the selected fns as
 * cards at the end of the system prompt or in a trailing system message. For a model without native tools the static
 * mode speaks the text protocol instead: no tools at all, `<run fn="…">{…}</run>` blocks in its answer.
 */
import type { Registry } from '@aeye/gin';
import { a, deferEncode, LENIENT, ObjectType, type AnySchema, type Bindable, type Bundle } from '@aeye/schema';
import { hub, type AnyFnRef } from '@harness/sdk';
import {
  ginBundle, HarnessGrammar, InstanceName, Json, JsonObject, modelFnName, modelFnNames, RULE_ONLY_NAMES, SYSTEM_NAME_PATTERN, type FnNameSpelling, type HarnessGrammarArgs, type ModelFnNames, type StaticToolFns, messageOf, problemLine, QualifiedName, STATIC_TOOLS, SystemName, type Detail, type FnBlock, type FnExample, type InputProblem, type InvalidInput, type StaticMode, type StaticTool,
} from '@harness/core';
import { executingSystem } from '../execution/runs.ts';
import type { CatalogFnNames } from '../catalog/index.ts';
import { bindable, isObjectBound, jsonSchemaOf } from '../catalog/signature.ts';
import { searchSystems } from '../chat/support.ts';
import type {
  CallPlan, CallProtocol, CallScope, ChatMode, ChatModeFactories, ChosenFn, ContextorDeps, FnView, ModeContext, ModelCallOut, ModeTool, RenderedIteration, Selection,
} from './index.ts';
import { blockedLine, cardsSection, describedWithEffects, fnCard, toolExampleLines, moreFns, summaryHint, tableInstruction, textProtocolInstructions } from './render.ts';
import { fnRefusal, readsAsMissing } from './views.ts';

/** The static toolset's hub fns, by tool name, with their declarations. `run` is not among them: it runs the fn it names. */
export const STATIC_HUB_FNS = {
  // the static `find` tool is `hub/fns_search` (fns), `find_ctx` is `hub/ctx_search` (context)
  find: { ref: hub.fns.fns_search, def: hub.defs.fns.fns_search },
  find_ctx: { ref: hub.fns.ctx_search, def: hub.defs.fns.ctx_search },
  inspect: { ref: hub.fns.inspect, def: hub.defs.fns.inspect },
  load: { ref: hub.fns.load, def: hub.defs.fns.load },
  unload: { ref: hub.fns.unload, def: hub.defs.fns.unload },
} as const satisfies Record<Exclude<StaticTool, 'run'>, { readonly ref: AnyFnRef; readonly def: StaticToolDef }>;

/** What a static tool's hub fn says of itself: its description, instructions and examples, all of which its tool carries. */
interface StaticToolDef {
  readonly description: string;
  readonly instructions?: string | undefined;
  readonly examples?: ReadonlyArray<{ readonly args: unknown; readonly note?: string | undefined }> | undefined;
}

/** The search, load and drop fns whose jobs `find`, `find_ctx`, `load` and `unload` do in static mode, so it never shows them. */
export const REPLACED_BY_STATIC: ReadonlySet<string> = new Set<string>([
  hub.fns.fns_search.name, hub.fns.fns_load.name, hub.fns.fns_drop.name, hub.fns.ctx_search.name, hub.fns.ctx_load.name, hub.fns.ctx_drop.name,
]);

/**
 * The static tools' hub fns for the one fn name: static mode names each tool's own hub fn, and the fns whose jobs it
 * does (`REPLACED_BY_STATIC`), by the tool (`hub/fns_search` reads `find`, `hub/fns_load` and `hub/ctx_load` read
 * `load`), so one text reads right in both modes. Every other fn reads as its model name, which `run` takes as `fn`.
 */
export const STATIC_TOOL_FNS: StaticToolFns = {
  find: { fn: STATIC_HUB_FNS.find.ref.name },
  find_ctx: { fn: STATIC_HUB_FNS.find_ctx.ref.name },
  inspect: { fn: STATIC_HUB_FNS.inspect.ref.name },
  load: { fn: STATIC_HUB_FNS.load.ref.name, also: [hub.fns.fns_load.name, hub.fns.ctx_load.name] },
  unload: { fn: STATIC_HUB_FNS.unload.ref.name, also: [hub.fns.fns_drop.name, hub.fns.ctx_drop.name] },
};

/**
 * The fn names a prompt in this chat mode speaks (core's `modelFnNames`), over the hub's registry; with none (a mode
 * built in a test), names read back by the rule alone.
 */
export function modeNames(type: 'tools' | 'static', registry?: CatalogFnNames): ModelFnNames {
  return modelFnNames({
    index: registry?.index ?? RULE_ONLY_NAMES,
    mode: type === 'static' ? { type, tools: STATIC_TOOL_FNS } : { type },
    types: registry?.types,
  });
}

/** The `run` tool's args as the web and MCP read them (core's). */
export { RunArgs } from '@harness/core';

/** What the static `run` tool says of itself: it is not a fn, it runs the fn it names. */
const RUN_TOOL_DESCRIPTION = 'Run any fn by its name, as its card names it, with the args its card shows, as one JSON object. Its result, or what was wrong with the args, comes back as this call\'s result.';
/**
 * The `run` tool's example: a run of `hub/fns_examples` for `hub/fns_get`, written through the request's plan once it is
 * made (a deferred value: on a strict dialect `args` is JSON text). A fn the prompt doesn't decode `run`'s args for takes
 * them as the hub reads them back (its fn names as the model spells them), so they go in already written so.
 */
function runInstructions(decoded: ReadonlyMap<QualifiedName, AnySchema>, names: FnNameSpelling | undefined): string {
  const ref = hub.fns.fns_examples;
  const args = { fn: hub.fns.fns_get.name };
  const given = decoded.has(ref.name) || names === undefined ? args : contractBundle(ref).bind(ref.args.registry, names).render(LENIENT).encode(args);
  return `Example args: ${deferEncode({ tool: 'run', value: { fn: ref.name, args: given } })}`;
}

/** How many near names an unknown fn's reply offers. */
const NEAR_NAMES = 3;

/**
 * A native tool: its args bound for the prompt (`@aeye/core` plans, checks and decodes calls with them) and its
 * parameters in the code shape (`LENIENT`, for estimates and records).
 */
export function modeTool(name: string, description: string, schema: Bindable<object>, parameters: Record<string, unknown>, instructions?: string): ModeTool {
  return { name, description, ...(instructions === undefined ? {} : { instructions }), schema, spec: { name, description: instructions === undefined ? description : `${description}\n\n${instructions}`, parameters: Json.parse(parameters) } };
}

/** What a fleet's `on` choice tells the model. */
const ON_DESCRIPTION = 'Which machine runs it: this system has several connected.';

/** The connected instances a fn's calls choose between: those of its executing system, when it has more than one. */
export function machinesOf(view: FnView, instances: ContextorDeps['instances']): readonly InstanceName[] {
  const machines = instances.connected(SystemName.parse(executingSystem(view.record)));
  return machines.length > 1 ? machines : [];
}

/**
 * A fn's native tool (build 1's `fnTool` definition), or none when its args aren't an object. Its args are its
 * signature's model schema bound with the prompt's `names` (none: fn-name fields are plain text, for estimates). Given
 * a fleet's machines, its args gain an optional `on`, one of them (`fleetArgs` takes it out again).
 */
export function fnModeTool(view: FnView, machines: readonly InstanceName[] = [], examples?: readonly FnExample[], names?: ModelFnNames): ModeTool | undefined {
  const { signature } = view;
  if (!isObjectBound(signature.argsFor())) return undefined;
  const args = signature.argsFor(names);
  // a fn's tool is named by its model name, the one name the model knows it by
  const name = modelFnName(view.record.name);
  const [first, ...rest] = machines;
  const shown = toolExampleLines(view, name, examples, names);
  const instructions = [view.record.decl.instructions, ...shown].filter((line) => line !== undefined && line.trim() !== '').join('\n') || undefined;
  const description = describedWithEffects(view);
  if (first === undefined || !(args.root instanceof ObjectType)) return modeTool(name, description, bindable(args), signature.argsJsonSchema, instructions);
  // the machines are runtime (the instances connected now), so a fleet fn's schema is made for the prompt
  const fleet = HarnessGrammar.result<object>(args.root.extend({ on: a.enum([first, ...rest]).optional().describe(ON_DESCRIPTION) })).bind(signature.args.registry, names);
  return modeTool(name, description, bindable(fleet), jsonSchemaOf(fleet), instructions);
}

/** A fleet call's args without its `on`, and the instance it names; an `on` that names no instance is refused. */
export function fleetArgs(args: Json): { args: Json; on?: InstanceName } | { problem: InputProblem } {
  const object = JsonObject.safeParse(args);
  if (!object.success || !('on' in object.data)) return { args };
  const { on, ...rest } = object.data;
  const named = InstanceName.safeParse(on);
  return named.success ? { args: rest, on: named.data } : { problem: { path: 'on', message: 'on must name one of the machines the tool lists' } };
}

/** The static toolset's hub fns' args as a model is shown them (their gin types, as code takes them), made once each. */
const contractArgs = new Map<string, Bundle<object, HarnessGrammarArgs>>();
function contractBundle(ref: AnyFnRef): Bundle<object, HarnessGrammarArgs> {
  let bundle = contractArgs.get(ref.name);
  if (bundle === undefined) contractArgs.set(ref.name, (bundle = ginBundle<object>(ref.args)));
  return bundle;
}

/**
 * A tool from a contract fn (the static toolset's hub fns): its description and its first example. The static toolset
 * is for small windows, so its fixed tools stay short: the fns' longer instructions are left to the mode's guide.
 */
function contractTool(name: string, ref: AnyFnRef, def: StaticToolDef, description: string, names: FnNameSpelling | undefined): ModeTool {
  const bundle = contractBundle(ref);
  if (!isObjectBound(bundle.bind(ref.args.registry))) throw new Error(`${ref.name} takes no object, so it can't be a tool`);
  const [first] = def.examples ?? [];
  // written through the request's plan once it is made: the tool's own args
  const example = first === undefined ? undefined : `Example args: ${deferEncode({ tool: name, value: first.args })}`;
  // its parameters are the code shape's, the same for every prompt
  return modeTool(name, description, bindable(bundle.bind(ref.args.registry, names)), jsonSchemaOf(bundle.bind(ref.args.registry)), example);
}

/**
 * The static tools' short descriptions, for an agent that takes summaries (`ModeContext.brief`: a small window, Phil
 * 2026-11-22 "The systems list follows the agent's detail"). Their examples stay.
 */
export const STATIC_TOOL_BRIEF: Readonly<Record<StaticTool, string>> = {
  find: 'Search fns by what they do.',
  find_ctx: 'Search context (guides, memories, parts of files) by what it says.',
  inspect: 'See a fn\'s card or a context item\'s text, by its name.',
  load: 'Keep fns and context in your prompt, by their names.',
  unload: 'Take fns and context out of your prompt.',
  run: 'Run any fn by its name with its args as one JSON object; its result comes back.',
};

/**
 * A static tool that is a hub fn, as a native tool: its args are the hub fn's gin type (the one shape a chat and an
 * MCP share), fn-name fields spelled by `names`. `brief`: its short description.
 */
export function staticToolOf(name: keyof typeof STATIC_HUB_FNS, brief = false, names?: FnNameSpelling): ModeTool {
  const { ref, def } = STATIC_HUB_FNS[name];
  return contractTool(name, ref, def, brief ? STATIC_TOOL_BRIEF[name] : def.description, names);
}

/** A run call's args for a fn whose args the prompt doesn't decode: any JSON object, checked hub-side (`#run`). */
const ANY_ARGS = a.record(a.json()).describe('Its args, as its card shows them: one JSON object.');

/** The registry the static tools are made in (the hub contract's). */
const STATIC_REGISTRY = (): Registry => STATIC_HUB_FNS.inspect.ref.args.registry;

/**
 * The static `run` tool for one prompt: `fn` is a fn's name as the prompt spells it (read back to the qualified name),
 * `args` that fn's args as its own schema takes them when the prompt decodes it (`decoded`: the fns it shows and the
 * toolset's own, so core checks them and says what was wrong in its own words), any JSON object otherwise (checked
 * hub-side, `#run`), and `on` a machine's name.
 */
export function runTool(brief: boolean, names?: FnNameSpelling, decoded: ReadonlyMap<QualifiedName, AnySchema> = ownArgs(), registry: Registry = STATIC_REGISTRY()): ModeTool {
  const call = a.object({ fn: a.ref('FnName').describe('The fn to run, as its card names it.') })
    .dependent('args', 'fn', (fn) => (typeof fn === 'string' ? decoded.get(QualifiedName.parse(fn)) : undefined), ANY_ARGS);
  // a fn that takes nothing may be run without args
  const root = call.extend({
    args: call.shape.args.default({}),
    on: a.string().pattern(SYSTEM_NAME_PATTERN).optional().describe('For a system with several machines connected, which one runs it (laptop).'),
  });
  const bundle = HarnessGrammar.result<object>(root);
  return modeTool('run', brief ? STATIC_TOOL_BRIEF.run : RUN_TOOL_DESCRIPTION, bindable(bundle.bind(registry, names)), jsonSchemaOf(bundle.bind(registry)), runInstructions(decoded, names));
}

/** The args schemas of the toolset's own fns, by fn (what a `run` naming one of them is decoded with). */
export function ownArgs(): Map<QualifiedName, AnySchema> {
  return new Map(Object.values(STATIC_HUB_FNS).map(({ ref }): [QualifiedName, AnySchema] => [ref.name, contractBundle(ref).bind(ref.args.registry).root]));
}

/** A static `run` call as core decoded it: the fn's qualified name, its args, and the machine it names. */
function runCallOf(args: Json): { fn: string; args: Json; on?: string } | undefined {
  const call = JsonObject.safeParse(args);
  if (!call.success) return undefined;
  const { fn, args: given, on } = call.data;
  if (typeof fn !== 'string') return undefined;
  return { fn, args: given ?? {}, ...(typeof on === 'string' ? { on } : {}) };
}

/** An invalid-input plan. */
function invalid(fn: QualifiedName | undefined, source: InvalidInput['source'], problems: readonly InputProblem[], reply: string, given?: { raw?: string; args?: Json; blocked?: FnBlock }): CallPlan {
  const [first, ...rest] = problems;
  const listed: InvalidInput['problems'] = first === undefined ? [{ path: '', message: reply }] : [first, ...rest];
  const { raw, blocked } = given ?? {};
  const refused: InvalidInput = { source, problems: listed, ...(raw === undefined ? {} : { raw }), ...(blocked === undefined ? {} : { blocked }) };
  return { type: 'invalid', fn, invalid: refused, reply, ...(given?.args === undefined ? {} : { args: given.args }) };
}


/**
 * The reply to a call of a fn that exists but is blocked now (held for review, switched off, offline, another system,
 * an account to connect): what blocks it, in the hub's words, and to stop. Undefined when nothing blocks it, or when the
 * block reads as missing (unseen, not for the model), which the caller answers as an unknown name.
 */
function blockedCall(view: FnView | undefined, scope: CallScope): CallPlan | undefined {
  const blocked = view === undefined ? undefined : fnRefusal(view.record, scope.session, scope.access);
  if (view === undefined || blocked === undefined || readsAsMissing(blocked)) return undefined;
  const line = blockedLine(view.record.name, blocked);
  return invalid(view.record.name, 'schema', [{ path: 'fn', message: line }], `${line}. Don't call it again; tell the person what blocks it.`, { blocked });
}

/** Strict tools: one native tool per selected fn. */
export class ToolsChatMode implements ChatMode {
  readonly type = 'tools';
  readonly loadDetail = 'signature';
  readonly alwaysDetail = 'signature';
  readonly replaces: ReadonlySet<string> = new Set();
  readonly #deps: Pick<ContextorDeps, 'instances' | 'views'>;

  constructor(deps: Pick<ContextorDeps, 'instances' | 'views'>) {
    this.#deps = deps;
  }

  protocol(): CallProtocol {
    return 'native';
  }

  guide(): string {
    return '';
  }

  fixedTools(): Promise<readonly ModeTool[]> {
    return Promise.resolve([]);
  }

  cost(fn: FnView, detail: ChosenFn['detail'], ctx: ModeContext): number {
    if (detail === 'listed') return ctx.estimator.text(`${fnCard(fn, 'listed')}\n`);
    const tool = fnModeTool(fn, machinesOf(fn, this.#deps.instances));
    return tool === undefined ? 0 : ctx.estimator.tool(tool.spec);
  }

  render(selection: Selection, ctx?: ModeContext): Promise<RenderedIteration> {
    const tools: ModeTool[] = [];
    const fns = new Map<string, QualifiedName>();
    const fleet = new Set<string>();
    const listed: FnView[] = [];
    const names = ctx?.names ?? modeNames('tools');
    for (const chosen of selection.fns) {
      if (chosen.detail === 'listed') { listed.push(chosen.view); continue; }
      const machines = machinesOf(chosen.view, this.#deps.instances);
      const tool = fnModeTool(chosen.view, machines, chosen.examples, names);
      if (tool === undefined || fns.has(tool.name)) continue;
      tools.push(tool);
      fns.set(tool.name, chosen.view.record.name);
      if (machines.length > 0) fleet.add(tool.name);
    }
    const systemEnd = [moreFns(listed), tableInstruction(selection.fns.map((chosen) => chosen.view))].filter((part) => part !== '').join('\n\n');
    return Promise.resolve({ tools, systemEnd, tail: undefined, protocol: 'native', fns, fleet, names });
  }

  async interpret(call: ModelCallOut, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan> {
    const name = call.type === 'tool' ? call.name : call.fn ?? '';
    const fn = rendered.fns.get(name);
    if (fn === undefined || call.type !== 'tool') {
      // a held or offline fn's tool (a context named it, the model called it anyway) says what blocks it, as static `run` does
      await rendered.names.learn([name]);
      const meant = rendered.names.fn(name);
      const blocked = meant === undefined ? undefined : blockedCall(await this.#deps.views.view(meant), scope);
      return blocked ?? invalid(undefined, 'schema', [{ path: '', message: `no tool named ${name}` }], `There is no tool named ${name}.`);
    }
    // its args came decoded (core checked them against the tool's schema): fn-name fields are qualified names already
    const { args } = call;
    if (!rendered.fleet.has(name)) return { type: 'run', fn, args };
    const split = fleetArgs(args);
    if ('problem' in split) return invalid(fn, 'validation', [split.problem], problemLine(split.problem), { args: call.args });
    return { type: 'run', fn, args: split.args, ...(split.on === undefined ? {} : { on: split.on }) };
  }

  exposed(views: readonly ChosenFn[]): string {
    return moreFns(views.map((chosen) => chosen.view));
  }
}

/** The static toolset: five fixed tools, fn cards as text, and `run` for any fn. */
export class StaticChatMode implements ChatMode {
  readonly type = 'static';
  readonly loadDetail: Detail;
  readonly alwaysDetail = 'listed';
  readonly replaces = REPLACED_BY_STATIC;
  readonly #config: StaticMode;
  readonly #deps: ContextorDeps;

  constructor(config: StaticMode, deps: ContextorDeps) {
    this.#config = config;
    this.#deps = deps;
    this.loadDetail = config.loadDetail;
  }

  protocol(nativeTools: boolean): CallProtocol {
    switch (this.#config.protocol) {
      case 'auto': return nativeTools ? 'native' : 'text';
      case 'native': return 'native';
      case 'text': return 'text';
    }
  }

  guide(ctx: ModeContext): string {
    if (ctx.protocol === 'text') return textProtocolInstructions();
    return [
      'Answer from the context below when it holds the answer.',
      'Use find({ text: "what you need, in a few words" }) to look for fns, find_ctx({ text: "…" }) for context (guides, memories), inspect or load to see them, and run({ fn, args }) to run any fn by name.',
      summaryHint('inspect({ name: "<its name>", detail: "full" })'),
    ].join('\n');
  }

  fixedTools(ctx: ModeContext, decoded?: ReadonlyMap<QualifiedName, AnySchema>): Promise<readonly ModeTool[]> {
    if (ctx.protocol === 'text') return Promise.resolve([]);
    const brief = ctx.brief === true;
    const tools = STATIC_TOOLS.map((name): ModeTool => (name === 'run' ? runTool(brief, ctx.names, decoded) : staticToolOf(name, brief, ctx.names)));
    return Promise.resolve(tools);
  }

  cost(fn: FnView, detail: ChosenFn['detail'], ctx: ModeContext): number {
    return ctx.estimator.text(`${fnCard(fn, detail)}\n\n`);
  }

  async render(selection: Selection, ctx: ModeContext): Promise<RenderedIteration> {
    const shown = new Set<QualifiedName>();
    const cards = selection.fns.map((chosen) => fnCard(chosen.view, chosen.detail, shown, chosen.examples, undefined, ctx.writer));
    const section = [cardsSection(cards, ctx.protocol), tableInstruction(selection.fns.map((chosen) => chosen.view))].filter((part) => part !== '').join('\n\n');
    // a `run` of a fn the prompt shows (or one of the toolset's own) is decoded with that fn's args, so core checks them
    const decoded = ownArgs();
    for (const chosen of selection.fns) decoded.set(chosen.view.record.name, chosen.view.signature.argsFor().root);
    const tools = await this.fixedTools(ctx, decoded);
    const fns = new Map<string, QualifiedName>(Object.entries(STATIC_HUB_FNS).map(([tool, { ref }]) => [tool, ref.name]));
    const tail = this.#config.placement === 'tail' && section !== '' ? section : undefined;
    return {
      tools, systemEnd: tail === undefined ? section : '', tail, protocol: ctx.protocol, fns, fleet: new Set(), names: ctx.names ?? modeNames('static'),
      ...(ctx.protocol === 'native' ? { decoded: new Set(decoded.keys()) } : {}),
    };
  }

  async interpret(call: ModelCallOut, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan> {
    if (call.type === 'tool') {
      if (call.name !== 'run') {
        const fn = rendered.fns.get(call.name);
        // its args came decoded through its own schema: fn-name fields are qualified names already
        return fn === undefined ? invalid(undefined, 'schema', [{ path: '', message: `no tool named ${call.name}` }], `There is no tool named ${call.name}; use one of ${STATIC_TOOLS.join(', ')}.`) : { type: 'run', fn, args: call.args };
      }
      const run = runCallOf(call.args);
      if (run === undefined) return invalid(undefined, 'schema', [{ path: 'fn', message: 'run names no fn' }], 'run needs { fn, args }: the fn to run, by its name, and its args as one JSON object.');
      const on = run.on === undefined ? undefined : InstanceName.safeParse(run.on);
      const fn = QualifiedName.safeParse(run.fn).data;
      if (on?.success === false) return invalid(fn, 'schema', [{ path: 'on', message: 'on must name a machine, like laptop' }], `on "${run.on}" names no machine: write a machine's name, like laptop.`);
      return this.#run(run.fn, run.args, rendered, scope, on?.data, fn !== undefined && rendered.decoded?.has(fn) === true);
    }
    if (call.fn === undefined) return invalid(undefined, 'schema', [{ path: 'fn', message: 'the block has no fn attribute' }], `That block names no fn: write <run fn="${modelFnName(hub.fns.fns_get.name)}">{ args }</run>.`, { raw: call.json });
    let args: Json;
    try {
      args = call.json === '' ? {} : Json.parse(JSON.parse(call.json));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(QualifiedName.safeParse(call.fn).data, 'json', [{ path: '', message }], `The args of that ${call.fn} block are not JSON (${message}). Write them as one JSON object.`, { raw: call.json });
    }
    if (call.on === undefined) return this.#run(call.fn, args, rendered, scope);
    const on = InstanceName.safeParse(call.on);
    if (!on.success) return invalid(QualifiedName.safeParse(call.fn).data, 'schema', [{ path: 'on', message: 'on must name a machine, like laptop' }], `on="${call.on}" names no machine: write a machine's name, like on="laptop".`, { raw: call.json });
    return this.#run(call.fn, args, rendered, scope, on.data);
  }

  exposed(views: readonly ChosenFn[], ctx?: ModeContext): string {
    const shown = new Set<QualifiedName>();
    return views.map((chosen) => fnCard(chosen.view, chosen.detail, shown, chosen.examples, undefined, ctx?.writer)).join('\n\n');
  }

  /**
   * A run of a fn by name: one of the toolset's own, or any fn the session may use, its args checked first. `decoded`:
   * a native `run` whose args core decoded and checked with the fn's own schema (the name is the qualified name then);
   * otherwise the args are as the model wrote them (a `<run>` block, a fn the prompt doesn't show), read back and
   * checked here with the same check, told in `@aeye/schema`'s words.
   */
  async #run(name: string, args: Json, rendered: RenderedIteration, scope: CallScope, on?: InstanceName, decoded = false): Promise<CallPlan> {
    const own = rendered.fns.get(name) ?? [...rendered.fns.values()].find((fn) => fn === name);
    if (own !== undefined) return { type: 'run', fn: own, args: decoded ? args : await readArgs(args, own, rendered, this.#deps.views), ...(on === undefined ? {} : { on }) };
    // the name as the model wrote it (its model name; a qualified name is tolerated), read back through the registry
    if (!decoded) await rendered.names.learn([name, args]);
    const qualified = QualifiedName.safeParse(rendered.names.fn(name));
    // a fn that exists but can't run says what blocks it, in the hub's words; a missing one (or one not for the model) gets the nearest names
    const view = qualified.success ? await this.#deps.views.view(qualified.data) : undefined;
    const blocked = blockedCall(view, scope);
    if (blocked !== undefined) return blocked;
    if (view === undefined || fnRefusal(view.record, scope.session, scope.access) !== undefined) {
      const near = (await this.#near(name, scope)).map((hit) => { const fn = QualifiedName.safeParse(hit); return fn.success ? rendered.names.name(fn.data) : hit; });
      const hint = near.length === 0 ? 'Use find to look for one.' : `The nearest: ${near.join(', ')}.`;
      return invalid(qualified.success ? qualified.data : undefined, 'schema', [{ path: 'fn', message: `no fn named ${name} can run here` }], `There is no fn ${name} you can run here. ${hint}`);
    }
    if (decoded) return { type: 'run', fn: view.record.name, args, ...(on === undefined ? {} : { on }) };
    const read = rendered.names.read(args, view.record.decl.args);
    // the fn's own check: an object or list sent as a string holding its JSON fits once read as that JSON
    const checked = view.signature.check(read);
    if (!checked.ok) return invalid(view.record.name, 'schema', checked.problems, `The args don't fit ${view.record.name}:\n${checked.message}\n\n${fnCard(view, 'full')}`, { args });
    // the args go to the run as read, so the run checks them again and records what it repaired
    return { type: 'run', fn: view.record.name, args: read, ...(on === undefined ? {} : { on }) };
  }

  /** The fns whose names or descriptions are nearest an unknown name. */
  async #near(name: string, scope: CallScope): Promise<string[]> {
    try {
      const hits = await this.#deps.search.search({ text: name.replaceAll('__', ' '), kinds: ['fn'], limit: NEAR_NAMES, ...(scope.session === undefined ? {} : { systems: searchSystems(scope.session) }) });
      return hits.map((hit) => hit.key);
    } catch (error) {
      this.#deps.log.warn('contextor.near-failed', { name, error: messageOf(error) });
      return [];
    }
  }
}

/** A call's args with their fn-name fields (`g.fnName()`) read back to qualified names, by the fn's declared args. */
async function readArgs(args: Json, fn: QualifiedName, rendered: RenderedIteration, views: ContextorDeps['views']): Promise<Json> {
  const view = await views.view(fn);
  if (view === undefined) return args;
  // a cut model name in a fn-name field reads back only through the registry
  await rendered.names.learn([args]);
  return rendered.names.read(args, view.record.decl.args);
}

/** Every chat mode, by config type. */
export const CHAT_MODES: ChatModeFactories = {
  tools: (_config, deps) => new ToolsChatMode(deps),
  static: (config, deps) => new StaticChatMode(config, deps),
};
