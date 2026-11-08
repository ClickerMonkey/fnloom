/**
 * The chat modes. `tools` is build 1's strict mode: every selected fn at `signature` or `full` is a native tool, and
 * `listed` fns are a `<more_fns>` list the model can load. `static` always sends the same five tools (`find`,
 * `inspect`, `load`, `unload`, which are the hub fns of those names, and `run`, which is not a fn: a call of it
 * becomes a run of the fn it names, its args checked against that fn's type first), and shows the selected fns as
 * cards at the end of the system prompt or in a trailing system message. For a model without native tools the static
 * mode speaks the text protocol instead: no tools at all, `<run fn="…">{…}</run>` blocks in its answer.
 */
import { hub, type AnyFnRef } from '@harness/sdk';
import {
  Json, messageOf, QualifiedName, STATIC_TOOLS, type Detail, type InputProblem, type InvalidInput, type StaticMode, type StaticTool,
} from '@harness/core';
import { z } from 'zod';
import { isObjectSchema, toolName } from '../execution/wire.ts';
import { searchSystems } from '../chat/support.ts';
import type {
  CallPlan, CallProtocol, CallScope, ChatMode, ChatModeFactories, ChosenFn, ContextorDeps, FnView, ModeContext, ModelCallOut, ModeTool, RenderedIteration, Selection,
} from './index.ts';
import { cardsSection, fnCard, listedLine, moreFns, problemLines, textProtocolInstructions } from './render.ts';
import { usable } from './views.ts';

/** The static toolset's hub fns, by tool name, with their declarations. `run` is not among them: it runs the fn it names. */
export const STATIC_HUB_FNS = {
  find: { ref: hub.fns.find, def: hub.defs.fns.find },
  inspect: { ref: hub.fns.inspect, def: hub.defs.fns.inspect },
  load: { ref: hub.fns.load, def: hub.defs.fns.load },
  unload: { ref: hub.fns.unload, def: hub.defs.fns.unload },
} as const satisfies Record<Exclude<StaticTool, 'run'>, { readonly ref: AnyFnRef; readonly def: { readonly description: string } }>;

/** The `run` tool's args. */
export const RunArgs = z.object({
  fn: z.string().min(1).describe('The fn to run, by its qualified name (fs/read).'),
  args: z.record(z.string(), z.json()).default({}).describe('Its args, as its card shows them.'),
});

/** How many near names an unknown fn's reply offers. */
const NEAR_NAMES = 3;

/** A native tool from a zod schema of objects. */
export function modeTool(name: string, description: string, schema: z.ZodType<object>, parameters: Record<string, unknown>, instructions?: string): ModeTool {
  return { name, description, ...(instructions === undefined ? {} : { instructions }), schema, spec: { name, description: instructions === undefined ? description : `${description}\n\n${instructions}`, parameters: Json.parse(parameters) } };
}

/** A fn's native tool (build 1's `fnTool` definition), or none when its args aren't an object. */
export function fnModeTool(view: FnView): ModeTool | undefined {
  const schema = view.signature.argsSchema;
  if (!isObjectSchema(schema)) return undefined;
  return modeTool(toolName(view.record.name), view.record.decl.description, schema, view.signature.argsJsonSchema, view.record.decl.instructions);
}

/** A tool from a contract fn (the static toolset's hub fns). */
function contractTool(name: string, ref: AnyFnRef, description: string): ModeTool {
  const schema = ref.args.toValueSchema();
  if (!isObjectSchema(schema)) throw new Error(`${ref.name} takes no object, so it can't be a tool`);
  return modeTool(name, description, schema, z.toJSONSchema(schema, { unrepresentable: 'any' }));
}

/** The problems of a zod failure, by dotted path. */
export function problemsOf(error: z.ZodError): InputProblem[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

/** An invalid-input plan. */
function invalid(fn: QualifiedName | undefined, source: InvalidInput['source'], problems: readonly InputProblem[], reply: string, raw?: string): CallPlan {
  const [first, ...rest] = problems;
  const listed: InvalidInput['problems'] = first === undefined ? [{ path: '', message: reply }] : [first, ...rest];
  return { type: 'invalid', fn, invalid: { source, problems: listed, ...(raw === undefined ? {} : { raw }) }, reply };
}


/** Strict tools: one native tool per selected fn. */
export class ToolsChatMode implements ChatMode {
  readonly type = 'tools';
  readonly loadDetail = 'signature';
  readonly alwaysDetail = 'signature';

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
    if (detail === 'listed') return ctx.estimator.text(`- ${listedLine(fn.record.name, fn.record.decl.description)}\n`);
    const tool = fnModeTool(fn);
    return tool === undefined ? 0 : ctx.estimator.tool(tool.spec);
  }

  render(selection: Selection): Promise<RenderedIteration> {
    const tools: ModeTool[] = [];
    const fns = new Map<string, QualifiedName>();
    const listed: string[] = [];
    for (const chosen of selection.fns) {
      if (chosen.detail === 'listed') { listed.push(listedLine(chosen.view.record.name, chosen.view.record.decl.description)); continue; }
      const tool = fnModeTool(chosen.view);
      if (tool === undefined || fns.has(tool.name)) continue;
      tools.push(tool);
      fns.set(tool.name, chosen.view.record.name);
    }
    return Promise.resolve({ tools, systemEnd: moreFns(listed), tail: undefined, protocol: 'native', fns });
  }

  interpret(call: ModelCallOut, rendered: RenderedIteration): Promise<CallPlan> {
    const name = call.type === 'tool' ? call.name : call.fn ?? '';
    const fn = rendered.fns.get(name);
    if (fn === undefined || call.type !== 'tool') return Promise.resolve(invalid(undefined, 'schema', [{ path: '', message: `no tool named ${name}` }], `There is no tool named ${name}.`));
    return Promise.resolve({ type: 'run', fn, args: call.args });
  }

  exposed(views: readonly ChosenFn[]): string {
    return moreFns(views.map((chosen) => listedLine(chosen.view.record.name, chosen.view.record.decl.description)));
  }
}

/** The static toolset: five fixed tools, fn cards as text, and `run` for any fn. */
export class StaticChatMode implements ChatMode {
  readonly type = 'static';
  readonly loadDetail: Detail;
  readonly alwaysDetail = 'listed';
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
    return 'Use find to look for fns and context, inspect or load to see them, and run({ fn, args }) to run any fn by name.';
  }

  fixedTools(ctx: ModeContext): Promise<readonly ModeTool[]> {
    if (ctx.protocol === 'text') return Promise.resolve([]);
    const tools = STATIC_TOOLS.map((name): ModeTool => {
      if (name === 'run') return modeTool('run', 'Run any fn by its qualified name with its args. A loaded fn\'s card shows its args.', RunArgs, z.toJSONSchema(RunArgs, { io: 'input' }));
      const { ref, def } = STATIC_HUB_FNS[name];
      return contractTool(name, ref, def.description);
    });
    return Promise.resolve(tools);
  }

  cost(fn: FnView, detail: ChosenFn['detail'], ctx: ModeContext): number {
    return ctx.estimator.text(`${fnCard(fn, detail, ctx.protocol)}\n\n`);
  }

  async render(selection: Selection, ctx: ModeContext): Promise<RenderedIteration> {
    const shown = new Set<QualifiedName>();
    const cards = selection.fns.map((chosen) => fnCard(chosen.view, chosen.detail, ctx.protocol, shown));
    const section = cardsSection(cards, ctx.protocol);
    const tools = await this.fixedTools(ctx);
    const fns = new Map<string, QualifiedName>(Object.entries(STATIC_HUB_FNS).map(([tool, { ref }]) => [tool, ref.name]));
    const tail = this.#config.placement === 'tail' && section !== '' ? section : undefined;
    return { tools, systemEnd: tail === undefined ? section : '', tail, protocol: ctx.protocol, fns };
  }

  async interpret(call: ModelCallOut, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan> {
    if (call.type === 'tool') {
      if (call.name !== 'run') {
        const fn = rendered.fns.get(call.name);
        return fn === undefined ? invalid(undefined, 'schema', [{ path: '', message: `no tool named ${call.name}` }], `There is no tool named ${call.name}; use one of ${STATIC_TOOLS.join(', ')}.`) : { type: 'run', fn, args: call.args };
      }
      const parsed = RunArgs.safeParse(call.args);
      if (!parsed.success) return invalid(undefined, 'schema', problemsOf(parsed.error), `run needs { fn, args }:\n${problemLines(problemsOf(parsed.error))}`);
      return this.#run(parsed.data.fn, parsed.data.args, rendered, scope);
    }
    if (call.fn === undefined) return invalid(undefined, 'schema', [{ path: 'fn', message: 'the block has no fn attribute' }], 'That block names no fn: write <run fn="system/name">{ args }</run>.', call.json);
    let args: Json;
    try {
      args = call.json === '' ? {} : Json.parse(JSON.parse(call.json));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(QualifiedName.safeParse(call.fn).data, 'json', [{ path: '', message }], `The args of that ${call.fn} block are not JSON (${message}). Write them as one JSON object.`, call.json);
    }
    return this.#run(call.fn, args, rendered, scope);
  }

  exposed(views: readonly ChosenFn[], ctx: ModeContext): string {
    const shown = new Set<QualifiedName>();
    return views.map((chosen) => fnCard(chosen.view, chosen.detail, ctx.protocol, shown)).join('\n\n');
  }

  /** A run of a fn by name: one of the toolset's own, or any fn the session may use, its args checked first. */
  async #run(name: string, args: Json, rendered: RenderedIteration, scope: CallScope): Promise<CallPlan> {
    const own = rendered.fns.get(name);
    if (own !== undefined) return { type: 'run', fn: own, args };
    const qualified = QualifiedName.safeParse(name);
    const view = qualified.success ? await this.#deps.views.view(qualified.data) : undefined;
    if (view === undefined || !usable(view.record, scope.session)) {
      const near = await this.#near(name, scope);
      const hint = near.length === 0 ? 'Use find to look for one.' : `The nearest: ${near.join(', ')}.`;
      return invalid(qualified.success ? qualified.data : undefined, 'schema', [{ path: 'fn', message: `no fn named ${name} can run here` }], `There is no fn ${name} you can run here. ${hint}`);
    }
    const checked = view.signature.argsSchema.safeParse(args);
    if (!checked.success) {
      const problems = problemsOf(checked.error);
      return invalid(view.record.name, 'schema', problems, `The args don't fit ${view.record.name}:\n${problemLines(problems)}\n\n${fnCard(view, 'full', rendered.protocol)}`);
    }
    return { type: 'run', fn: view.record.name, args: Json.parse(checked.data) };
  }

  /** The fns whose names or descriptions are nearest an unknown name. */
  async #near(name: string, scope: CallScope): Promise<string[]> {
    try {
      const hits = await this.#deps.search.search({ text: name, kinds: ['fn'], limit: NEAR_NAMES, ...(scope.session === undefined ? {} : { systems: searchSystems(scope.session) }) });
      return hits.map((hit) => hit.key);
    } catch (error) {
      this.#deps.log.warn('contextor.near-failed', { name, error: messageOf(error) });
      return [];
    }
  }
}

/** Every chat mode, by config type. */
export const CHAT_MODES: ChatModeFactories = {
  tools: () => new ToolsChatMode(),
  static: (config, deps) => new StaticChatMode(config, deps),
};
