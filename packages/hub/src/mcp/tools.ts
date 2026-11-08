/**
 * A hub MCP's tools (`HubMcpTools`, an `McpToolSource` over `@ayepi/mcp`'s `McpToolSet`). Two ways to offer fns:
 *
 * - `each`: one tool per exposed fn, named `<system>_<local>` (`fs_read`), its input the fn's args as JSON Schema,
 *   `readOnlyHint` for fns tagged `read`. The fn checks its own args (a misfit is refused input the model reads).
 * - `static`: the chat's static toolset scoped to the MCP: `find` (exposed fns by what they do), `inspect` (a fn's
 *   card, the same one the chat's static mode shows) and `run` (any exposed fn by name, with its args).
 *
 * The list is rebuilt when the scope may have changed (`refresh`), and listeners hear only when it really changed.
 * Every call resolves the scope again, so a tool hidden since the client listed it is refused, not run.
 */
import { errorResult, McpToolSet, textResult, type McpCaller, type McpToolResult, type McpToolSource } from '@ayepi/mcp';
import type { Logger } from '@ayepi/log';
import { Json, QualifiedName, READ_TAG, type FnRecord, type HubMcp, type HubMcpId, type StaticTool } from '@harness/core';
import { mcpToolNameOf } from '@harness/sdk/server';
import { z } from 'zod';
import type { Catalog } from '../catalog/index.ts';
import type { FnViewSource } from '../contextor/index.ts';
import { fnCard, listedLine } from '../contextor/render.ts';
import type { McpRunner } from './calls.ts';
import type { McpRegistry, McpScopes } from './index.ts';


/** How many fns `find` lists when not asked. */
const FIND_LIMIT = 10;

/**
 * The args of the static tools an MCP serves, by name: the chat's static tools (`StaticTool`) less `load` and
 * `unload`, since an MCP client keeps no hub session for loaded fns to live in.
 */
export const MCP_STATIC_TOOLS = {
  find: z.object({ query: z.string().min(1).describe('What the fn should do, in words.'), limit: z.number().int().min(1).max(50).optional() }),
  inspect: z.object({ name: z.string().min(1).describe('The fn\'s qualified name, as `find` lists it (`fs/read`).') }),
  run: z.object({ fn: z.string().min(1).describe('The fn\'s qualified name.'), args: z.record(z.string(), z.unknown()).describe('The fn\'s args, as its card shows them.') }),
} as const satisfies Partial<Record<StaticTool, z.ZodObject>>;

/** How well a fn matches some words: the share of words found in its name and description. */
export function matchScore(fn: Pick<FnRecord, 'name' | 'decl'>, query: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  const haystack = `${fn.name} ${fn.decl.description}`.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length / words.length;
}

/** What the tools use. */
export interface HubMcpToolsDeps {
  readonly registry: () => Pick<McpRegistry, 'record'>;
  readonly scopes: () => Pick<McpScopes, 'scope'>;
  readonly catalog: () => Pick<Catalog, 'fns' | 'signature'>;
  readonly views: FnViewSource;
  readonly runner: Pick<McpRunner, 'call'>;
  readonly log: Logger;
}

/** One hub MCP's tools. */
export class HubMcpTools implements McpToolSource {
  readonly #mcp: HubMcpId;
  readonly #mode: HubMcp['toolMode'];
  readonly #deps: HubMcpToolsDeps;
  readonly #set = new McpToolSet();
  /** The listed tools as JSON, to tell a real change from a rebuild of the same list. */
  #listed = '';

  constructor(mcp: Pick<HubMcp, 'id' | 'toolMode'>, deps: HubMcpToolsDeps) {
    this.#mcp = mcp.id;
    this.#mode = mcp.toolMode;
    this.#deps = deps;
    if (this.#mode === 'static') this.#defineStatic();
  }

  tools() {
    return this.#set.tools();
  }

  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller): Promise<McpToolResult | undefined> {
    return this.#set.call(name, args, signal, caller);
  }

  onChange(listener: () => void): () => void {
    return this.#set.onChange(listener);
  }

  /** Rebuild the tool list from the scope now (`each` mode; the static toolset never changes). */
  async refresh(): Promise<void> {
    if (this.#mode === 'static') return;
    const fns = await this.#exposed();
    const defined = await Promise.all(fns.map(async (fn) => {
      const signature = await this.#deps.catalog().signature(fn.name);
      return { fn, inputSchema: z.toJSONSchema(signature.argsSchema, { io: 'input', unrepresentable: 'any' }) };
    }));
    const listed = JSON.stringify(defined.map(({ fn, inputSchema }) => [fn.name, fn.version, inputSchema]));
    if (listed === this.#listed) return;
    this.#listed = listed;
    this.#set.batch((set) => {
      set.clear();
      for (const { fn, inputSchema } of defined) {
        set.define({
          name: mcpToolNameOf(fn.name), title: fn.name, description: fn.decl.description, inputSchema, validate: false,
          annotations: { title: fn.name, readOnlyHint: fn.decl.tags.includes(READ_TAG) },
          run: (args, { signal, caller }) => this.#run(fn.name, args, signal, caller),
        });
      }
    });
    this.#deps.log.info('mcp.tools.listed', { mcp: this.#mcp, tools: defined.length });
  }

  /** The static toolset: find, inspect and run over the exposed fns. */
  #defineStatic(): void {
    this.#set.batch((set) => {
      set.define({
        name: 'find', description: 'Find fns you can run by what they do. Lists each as `name — description`; `inspect` one to see how to call it.',
        annotations: { readOnlyHint: true }, args: MCP_STATIC_TOOLS.find,
        run: async ({ query, limit }) => {
          const ranked = (await this.#exposed()).map((fn) => ({ fn, score: matchScore(fn, query) })).filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score || a.fn.name.localeCompare(b.fn.name)).slice(0, limit ?? FIND_LIMIT);
          return textResult(ranked.length === 0 ? 'No fn matches that; try other words.' : ranked.map((r) => listedLine(r.fn.name, r.fn.decl.description)).join('\n'));
        },
      });
      set.define({
        name: 'inspect', description: 'A fn\'s card: what it does, how to call it with `run`, its result, instructions, examples and the types it uses.',
        annotations: { readOnlyHint: true }, args: MCP_STATIC_TOOLS.inspect,
        run: async ({ name }) => {
          const fn = (await this.#exposed()).find((f) => f.name === name);
          const view = fn === undefined ? undefined : await this.#deps.views.view(fn.name);
          return view === undefined ? textResult(`There is no fn ${name} here; use find.`) : textResult(fnCard(view, 'full', 'native'));
        },
      });
      set.define({
        name: 'run', description: 'Run a fn by its name with its args (inspect it first to see them). Answers with its result.',
        args: MCP_STATIC_TOOLS.run,
        run: ({ fn, args }, { signal, caller }) => this.#run(fn, args, signal, caller),
      });
    });
  }

  /** Run an exposed fn, refusing one the scope doesn't hold now. */
  async #run(fn: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller): Promise<McpToolResult> {
    const [record, scope] = await Promise.all([this.#deps.registry().record(this.#mcp), this.#deps.scopes().scope(this.#mcp)]);
    if (record?.enabled !== true) return errorResult('This MCP is switched off.');
    const name = QualifiedName.safeParse(fn);
    if (!name.success || !scope.fns.has(name.data)) {
      this.#deps.log.warn('mcp.call.refused', { mcp: this.#mcp, tool: fn, reason: 'not exposed' });
      return errorResult(`${fn} is not available through this MCP.`);
    }
    const parsed = Json.safeParse(args);
    if (!parsed.success) return errorResult('The args are not plain JSON.');
    return this.#deps.runner.call(record, name.data, parsed.data, caller, signal);
  }

  /** The exposed fns' records, by name. */
  async #exposed(): Promise<FnRecord[]> {
    const scope = await this.#deps.scopes().scope(this.#mcp);
    const names = [...scope.fns];
    return names.length === 0 ? [] : (await this.#deps.catalog().fns({ names })).sort((a, b) => a.name.localeCompare(b.name));
  }
}
