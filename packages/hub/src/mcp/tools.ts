/**
 * A hub MCP's tools (`HubMcpTools`, an `McpToolSource` over `@ayepi/mcp`'s `McpToolSet`). Two ways to offer fns:
 *
 * - `each`: one tool per exposed fn, named `<system>_<local>` (`fs_read`), its input the fn's args as JSON Schema,
 *   `readOnlyHint` for fns tagged `read`. The fn checks its own args (a misfit is refused input the model reads).
 * - `static`: the chat's static toolset scoped to the MCP: `find` and `inspect` are the hub fns of those names (the
 *   same args, runs and metrics as in a chat; the hub fns keep their answers inside the MCP's scope), and `run` takes
 *   the chat's `RunArgs` (a fleet's `on` included) and runs any exposed fn by name.
 *
 * The list is rebuilt when the scope may have changed (`refresh`), and listeners hear only when it really changed.
 * Every call resolves the scope again, so a tool hidden since the client listed it is refused, not run.
 */
import { errorResult, McpToolSet, type McpCaller, type McpToolResult, type McpToolSource } from '@ayepi/mcp';
import type { Logger } from '@ayepi/log';
import { type InstanceName, Json, QualifiedName, READ_TAG, type FnRecord, type HubMcp, type HubMcpId } from '@harness/core';
import { mcpToolNameOf } from '@harness/sdk/server';
import { z } from 'zod';
import type { AccessService } from '../access/index.ts';
import type { Catalog } from '../catalog/index.ts';
import { RunArgs, STATIC_HUB_FNS, staticToolOf } from '../contextor/modes.ts';
import type { McpRunner } from './calls.ts';
import type { McpRegistry, McpScopes } from './index.ts';

/** The static tools an MCP serves: the chat's, less `load` and `unload` (an MCP client keeps no hub session to load into). */
export const MCP_STATIC_TOOLS = ['find', 'inspect', 'run'] as const;

/** What the tools use. */
export interface HubMcpToolsDeps {
  readonly registry: () => Pick<McpRegistry, 'record'>;
  readonly scopes: () => Pick<McpScopes, 'scope'>;
  readonly catalog: () => Pick<Catalog, 'fns' | 'signature'>;
  readonly runner: Pick<McpRunner, 'call'>;
  /** Visibility: only fns the MCP's person may use are listed. */
  readonly access: () => Pick<AccessService, 'scope'>;
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
  /** Who hears each call as it comes in. */
  readonly #callListeners = new Set<(caller: McpCaller) => void>();

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
    for (const listener of [...this.#callListeners]) listener(caller);
    return this.#set.call(name, args, signal, caller);
  }

  /** Hear each tool call as it comes in, with its caller (session tracking counts them). Returns an unsubscribe function. */
  onCall(listener: (caller: McpCaller) => void): () => void {
    this.#callListeners.add(listener);
    return () => { this.#callListeners.delete(listener); };
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

  /** The static toolset: the hub fns `find` and `inspect`, and `run` over the exposed fns. */
  #defineStatic(): void {
    this.#set.batch((set) => {
      for (const name of ['find', 'inspect'] as const) {
        const { ref, def } = STATIC_HUB_FNS[name];
        const tool = staticToolOf(name);
        set.define({
          name, description: def.description, inputSchema: z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }), validate: false, annotations: { readOnlyHint: true },
          run: (args, { signal, caller }) => this.#hubFn(ref.name, args, signal, caller),
        });
      }
      set.define({
        name: 'run', description: 'Run a fn by its name with its args (inspect it first to see them). Answers with its result.',
        args: RunArgs,
        run: ({ fn, args, on }, { signal, caller }) => this.#run(fn, args, signal, caller, on),
      });
    });
  }

  /** Run one of the static toolset's hub fns for the MCP's client (it answers within the MCP's scope). */
  async #hubFn(fn: QualifiedName, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller): Promise<McpToolResult> {
    const record = await this.#deps.registry().record(this.#mcp);
    if (record?.enabled !== true) return errorResult('This MCP is switched off.');
    const parsed = Json.safeParse(args);
    if (!parsed.success) return errorResult('The args are not plain JSON.');
    return this.#deps.runner.call(record, fn, parsed.data, caller, signal);
  }

  /** Run an exposed fn, refusing one the scope doesn't hold now. */
  async #run(fn: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal, caller: McpCaller, on?: InstanceName): Promise<McpToolResult> {
    const [record, scope] = await Promise.all([this.#deps.registry().record(this.#mcp), this.#deps.scopes().scope(this.#mcp)]);
    if (record?.enabled !== true) return errorResult('This MCP is switched off.');
    const name = QualifiedName.safeParse(fn);
    if (!name.success || !scope.fns.has(name.data)) {
      this.#deps.log.warn('mcp.call.refused', { mcp: this.#mcp, tool: fn, reason: 'not exposed' });
      return errorResult(`${fn} is not available through this MCP.`);
    }
    const parsed = Json.safeParse(args);
    if (!parsed.success) return errorResult('The args are not plain JSON.');
    return this.#deps.runner.call(record, name.data, parsed.data, caller, signal, on);
  }

  /** The exposed fns' records the MCP's person may use (visibility, and a connection for a per-person fn), by name. */
  async #exposed(): Promise<FnRecord[]> {
    const [scope, record] = await Promise.all([this.#deps.scopes().scope(this.#mcp), this.#deps.registry().record(this.#mcp)]);
    const names = [...scope.fns];
    if (names.length === 0 || record === undefined) return [];
    const access = await this.#deps.access().scope(record.user);
    return (await this.#deps.catalog().fns({ names })).filter((fn) => access.mayUse(fn)).sort((a, b) => a.name.localeCompare(b.name));
  }
}
