/**
 * The chat modes. `tools` is build 1's strict mode: every selected fn at `signature` or `full` is a native tool, and
 * `listed` fns are a `<more_fns>` list the model can load. `static` always sends the same six tools (`find`, which is
 * `hub/fns_search`, `find_ctx`, which is `hub/ctx_search`, `inspect`, `load`, `unload`, the hub fns of those names, and `run`, which is not a fn: a call of it
 * becomes a run of the fn it names, its args checked against that fn's type first), and shows the selected fns as
 * cards at the end of the system prompt or in a trailing system message. For a model without native tools the static
 * mode speaks the text protocol instead: no tools at all, `<run fn="…">{…}</run>` blocks in its answer.
 */
import { hub, type AnyFnRef } from '@harness/sdk';
import {
  FN_NAME_DESCRIPTION, FN_NAME_PATTERN, InstanceName, Json, RunArgs, JsonObject, modelFnName, modelFnNames, RULE_ONLY_NAMES, type ModelFnNames, type StaticToolFns, messageOf, problemLine, QualifiedName, STATIC_TOOLS, SystemName, type Detail, type FnBlock, type FnExample, type InputProblem, type InvalidInput, type StaticMode, type StaticTool,
} from '@harness/core';
import { z } from 'zod';
import { executingSystem } from '../execution/runs.ts';
import { isObjectSchema } from '../execution/wire.ts';
import type { CatalogFnNames } from '../catalog/index.ts';
import { searchSystems } from '../chat/support.ts';
import type {
  CallPlan, CallProtocol, CallScope, ChatMode, ChatModeFactories, ChosenFn, ContextorDeps, FnView, ModeContext, ModelCallOut, ModeTool, RenderedIteration, Selection,
} from './index.ts';
import { blockedLine, cardsSection, describedWithEffects, fnCard, toolExampleLines, moreFns, problemLines, summaryHint, tableInstruction, textProtocolInstructions } from './render.ts';
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

/**
 * A tool's JSON schema with every fn-name field (`g.fnName()`, a text of core's `FN_NAME_PATTERN`) described as one,
 * where its author said nothing, so the model writes the name its tools spell.
 */
export function withFnNameDocs(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(withFnNameDocs);
  if (schema === null || typeof schema !== 'object') return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, withFnNameDocs(value)]));
  return out['pattern'] === FN_NAME_PATTERN && out['description'] === undefined ? { ...out, description: FN_NAME_DESCRIPTION } : out;
}

/** The `run` tool's args (core's, so the web reads a call's fn the same way). */
export { RunArgs } from '@harness/core';

/** What the static `run` tool says of itself: it is not a fn, it runs the fn it names. */
const RUN_TOOL_DESCRIPTION = 'Run any fn by its name, as its card names it, with the args its card shows, as one JSON object. Its result, or what was wrong with the args, comes back as this call\'s result.';
const RUN_TOOL_INSTRUCTIONS = `Example args: {"fn":"${modelFnName(hub.fns.fns_examples.name)}","args":{"fn":"${modelFnName(hub.fns.fns_get.name)}"}}`;

/** How many near names an unknown fn's reply offers. */
const NEAR_NAMES = 3;

/** A native tool from a zod schema of objects. */
export function modeTool(name: string, description: string, schema: z.ZodType<object>, parameters: Record<string, unknown>, instructions?: string): ModeTool {
  return { name, description, ...(instructions === undefined ? {} : { instructions }), schema, spec: { name, description: instructions === undefined ? description : `${description}\n\n${instructions}`, parameters: withFnNameDocs(Json.parse(parameters)) } };
}

/** What a fleet's `on` choice tells the model. */
const ON_DESCRIPTION = 'Which machine runs it: this system has several connected.';

/** The connected instances a fn's calls choose between: those of its executing system, when it has more than one. */
export function machinesOf(view: FnView, instances: ContextorDeps['instances']): readonly InstanceName[] {
  const machines = instances.connected(SystemName.parse(executingSystem(view.record)));
  return machines.length > 1 ? machines : [];
}

/**
 * A fn's native tool (build 1's `fnTool` definition), or none when its args aren't an object. Given a fleet's
 * machines, its args gain an optional `on` naming one (`fleetArgs` takes it out again).
 */
export function fnModeTool(view: FnView, machines: readonly InstanceName[] = [], examples?: readonly FnExample[]): ModeTool | undefined {
  const schema = view.signature.argsSchema;
  if (!isObjectSchema(schema)) return undefined;
  // a fn's tool is named by its model name, the one name the model knows it by
  const name = modelFnName(view.record.name);
  const [first, ...rest] = machines;
  const shown = toolExampleLines(view.record, examples);
  const instructions = [view.record.decl.instructions, ...shown].filter((line) => line !== undefined && line.trim() !== '').join('\n') || undefined;
  const description = describedWithEffects(view);
  if (first === undefined || !(schema instanceof z.ZodObject)) return modeTool(name, description, schema, view.signature.argsJsonSchema, instructions);
  const on = z.enum([first, ...rest]).describe(ON_DESCRIPTION);
  const parameters = JsonObject.parse(view.signature.argsJsonSchema);
  const properties = JsonObject.safeParse(parameters['properties']).data ?? {};
  return modeTool(name, description, schema.extend({ on: on.optional() }), { ...parameters, properties: { ...properties, on: Json.parse(z.toJSONSchema(on)) } }, instructions);
}

/** A fleet call's args without its `on`, and the instance it names; an `on` that names no instance is refused. */
export function fleetArgs(args: Json): { args: Json; on?: InstanceName } | { problem: InputProblem } {
  const object = JsonObject.safeParse(args);
  if (!object.success || !('on' in object.data)) return { args };
  const { on, ...rest } = object.data;
  const named = InstanceName.safeParse(on);
  return named.success ? { args: rest, on: named.data } : { problem: { path: 'on', message: 'on must name one of the machines the tool lists' } };
}

/**
 * A tool from a contract fn (the static toolset's hub fns): its description and its first example. The static toolset
 * is for small windows, so its fixed tools stay short: the fns' longer instructions are left to the mode's guide.
 */
function contractTool(name: string, ref: AnyFnRef, def: StaticToolDef): ModeTool {
  const schema = ref.args.toValueSchema();
  if (!isObjectSchema(schema)) throw new Error(`${ref.name} takes no object, so it can't be a tool`);
  const [first] = def.examples ?? [];
  const example = first === undefined ? undefined : `Example args: ${JSON.stringify(first.args)}`;
  return modeTool(name, def.description, schema, z.toJSONSchema(schema, { unrepresentable: 'any' }), example);
}

/** A static tool that is a hub fn, as a native tool: its args are the hub fn's gin type (the one shape a chat and an MCP share). */
export function staticToolOf(name: keyof typeof STATIC_HUB_FNS): ModeTool {
  const { ref, def } = STATIC_HUB_FNS[name];
  return contractTool(name, ref, def);
}

/** The problems of a zod failure, by dotted path. */
export function problemsOf(error: z.ZodError): InputProblem[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
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
    for (const chosen of selection.fns) {
      if (chosen.detail === 'listed') { listed.push(chosen.view); continue; }
      const machines = machinesOf(chosen.view, this.#deps.instances);
      const tool = fnModeTool(chosen.view, machines, chosen.examples);
      if (tool === undefined || fns.has(tool.name)) continue;
      tools.push(tool);
      fns.set(tool.name, chosen.view.record.name);
      if (machines.length > 0) fleet.add(tool.name);
    }
    const systemEnd = [moreFns(listed), tableInstruction(selection.fns.map((chosen) => chosen.view))].filter((part) => part !== '').join('\n\n');
    return Promise.resolve({ tools, systemEnd, tail: undefined, protocol: 'native', fns, fleet, names: ctx?.names ?? modeNames('tools') });
  }

  async interpret(call: ModelCallOut, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan> {
    const name = call.type === 'tool' ? call.name : call.fn ?? '';
    const fn = rendered.fns.get(name);
    if (fn === undefined || call.type !== 'tool') {
      // a held or offline fn's tool (a context named it, the model called it anyway) says what blocks it, as static `run` does
      const meant = rendered.names.fn(name);
      const blocked = meant === undefined ? undefined : blockedCall(await this.#deps.views.view(meant), scope);
      return blocked ?? invalid(undefined, 'schema', [{ path: '', message: `no tool named ${name}` }], `There is no tool named ${name}.`);
    }
    // its args' fn-name fields come back as qualified names
    const args = await readArgs(call.args, fn, rendered, this.#deps.views);
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

  fixedTools(ctx: ModeContext): Promise<readonly ModeTool[]> {
    if (ctx.protocol === 'text') return Promise.resolve([]);
    const tools = STATIC_TOOLS.map((name): ModeTool => {
      if (name === 'run') return modeTool('run', RUN_TOOL_DESCRIPTION, RunArgs, z.toJSONSchema(RunArgs, { io: 'input' }), RUN_TOOL_INSTRUCTIONS);
      return staticToolOf(name);
    });
    return Promise.resolve(tools);
  }

  cost(fn: FnView, detail: ChosenFn['detail'], ctx: ModeContext): number {
    return ctx.estimator.text(`${fnCard(fn, detail)}\n\n`);
  }

  async render(selection: Selection, ctx: ModeContext): Promise<RenderedIteration> {
    const shown = new Set<QualifiedName>();
    const cards = selection.fns.map((chosen) => fnCard(chosen.view, chosen.detail, shown, chosen.examples));
    const section = [cardsSection(cards, ctx.protocol), tableInstruction(selection.fns.map((chosen) => chosen.view))].filter((part) => part !== '').join('\n\n');
    const tools = await this.fixedTools(ctx);
    const fns = new Map<string, QualifiedName>(Object.entries(STATIC_HUB_FNS).map(([tool, { ref }]) => [tool, ref.name]));
    const tail = this.#config.placement === 'tail' && section !== '' ? section : undefined;
    return { tools, systemEnd: tail === undefined ? section : '', tail, protocol: ctx.protocol, fns, fleet: new Set(), names: ctx.names ?? modeNames('static') };
  }

  async interpret(call: ModelCallOut, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan> {
    if (call.type === 'tool') {
      if (call.name !== 'run') {
        const fn = rendered.fns.get(call.name);
        return fn === undefined ? invalid(undefined, 'schema', [{ path: '', message: `no tool named ${call.name}` }], `There is no tool named ${call.name}; use one of ${STATIC_TOOLS.join(', ')}.`) : { type: 'run', fn, args: await readArgs(call.args, fn, rendered, this.#deps.views) };
      }
      const parsed = RunArgs.safeParse(call.args);
      if (!parsed.success) return invalid(undefined, 'schema', problemsOf(parsed.error), `run needs { fn, args }:\n${problemLines(problemsOf(parsed.error))}`);
      return this.#run(parsed.data.fn, parsed.data.args, rendered, scope, parsed.data.on);
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

  exposed(views: readonly ChosenFn[]): string {
    const shown = new Set<QualifiedName>();
    return views.map((chosen) => fnCard(chosen.view, chosen.detail, shown, chosen.examples)).join('\n\n');
  }

  /** A run of a fn by name: one of the toolset's own, or any fn the session may use, its args checked first. */
  async #run(name: string, args: Json, rendered: RenderedIteration, scope: CallScope, on?: InstanceName): Promise<CallPlan> {
    const own = rendered.fns.get(name);
    if (own !== undefined) return { type: 'run', fn: own, args: await readArgs(args, own, rendered, this.#deps.views), ...(on === undefined ? {} : { on }) };
    // the name as the model wrote it (its model name; a qualified name is tolerated), read back through the registry
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
    const checked = view.signature.argsSchema.safeParse(rendered.names.read(args, view.record.decl.args));
    if (!checked.success) {
      const problems = problemsOf(checked.error);
      return invalid(view.record.name, 'schema', problems, `The args don't fit ${view.record.name}:\n${problemLines(problems)}\n\n${fnCard(view, 'full')}`, { args });
    }
    return { type: 'run', fn: view.record.name, args: Json.parse(checked.data), ...(on === undefined ? {} : { on }) };
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
  return view === undefined ? args : rendered.names.read(args, view.record.decl.args);
}

/** Every chat mode, by config type. */
export const CHAT_MODES: ChatModeFactories = {
  tools: (_config, deps) => new ToolsChatMode(deps),
  static: (config, deps) => new StaticChatMode(config, deps),
};
