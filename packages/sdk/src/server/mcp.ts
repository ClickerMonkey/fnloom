/**
 * A system as an MCP server, with no extra code, served by `@ayepi/mcp` over stdio or Streamable HTTP:
 *
 * - its native fns the LLM may see are MCP tools, each named by its model name (`fs__read`, core's `modelFnName`: the
 *   one name a chat model sees too). `McpFace` is the `McpToolSource`: a tool's input
 *   schema is the fn's args as gin's value schema with every field's docs, as JSON schema; fns added or removed at
 *   runtime change the list, and clients hear `notifications/tools/list_changed`.
 * - its resources, when it serves any, are MCP resources (`McpResources`): roots and their children, a URI template
 *   per root, reads, and subscriptions when it can watch.
 * - its `/commands` are MCP prompts (`McpPrompts`), filled exactly as the hub fills them.
 *
 * Tool calls run here, as local runs on behalf of the MCP client: args and results are checked as usual, but nothing
 * goes through the hub's queue, so a fn whose run calls other fns, the hub's LLM or session state needs the hub link.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { createRequestListener } from '@ayepi/node';
import {
  errorResult, mcpHttp, mcpSourceServer, serveStdio, textResult,
  type McpHttpHandler, type McpServer, type McpTool, type McpToolResult, type McpToolSource,
} from '@ayepi/mcp';
import { Json, MAIN_INSTANCE, mintId, modelFnName, qualify, type RunRequest } from '@harness/core';
import { z } from 'zod';
import type { AnyFnDef } from '../fn.ts';
import type { McpServe } from './index.ts';
import { MCP_ACTOR, mcpAsker } from './mcp-caller.ts';
import { McpPrompts, type ContextTexts } from './mcp-prompts.ts';
import { McpResources } from './mcp-resources.ts';
import { ActiveRun, type RunEnvironment } from './run.ts';
import type { SystemTable } from './table.ts';
import { messageOf, problemsText } from './wire.ts';

/** How long an MCP call may run, and the largest HTTP request body in bytes (from the SDK's env slice). */
export interface McpLimits {
  readonly timeout: number;
  readonly maxBody: number;
}

/** A fn offered as a tool. */
interface Offered {
  readonly tool: McpTool;
  readonly local: string;
}

/** The system's native fns as MCP tools, with its resources and commands beside them, and the server and transport that offer them. */
export class McpFace implements McpToolSource {
  readonly #table: SystemTable;
  readonly #env: RunEnvironment;
  /** How long an MCP call may run, and the largest HTTP request body. */
  readonly #limits: McpLimits;
  readonly #server: McpServer;
  #http: { readonly server: HttpServer; readonly handler: McpHttpHandler } | undefined;
  /** The tools for the fns as they were last built, rebuilt when a fn is added, removed or replaced. */
  #offered: { readonly fns: ReadonlyArray<readonly [string, AnyFnDef]>; readonly byTool: ReadonlyMap<string, Offered> } | undefined;

  /** `contexts` fills the system's commands as prompts (the system runtime). */
  constructor(table: SystemTable, env: RunEnvironment, version: string, limits: McpLimits, contexts: ContextTexts) {
    this.#table = table;
    this.#env = env;
    this.#limits = limits;
    const provider = table.impl.resources;
    const prompts = new McpPrompts(table.contract.defs.context, contexts, () => mcpAsker(env.now()));
    this.#server = mcpSourceServer({
      tools: this,
      ...(provider === undefined ? {} : { resources: McpResources.of(provider, env.content) }),
      ...(prompts.empty ? {} : { prompts }),
    }, { serverInfo: { name: table.contract.name, version }, instructions: table.contract.description });
  }

  /** The MCP server (JSON-RPC: `initialize`, `ping`, `tools/*`, and `resources/*` and `prompts/*` when the system has them). */
  get server(): McpServer {
    return this.#server;
  }

  /** The tools offered now. */
  tools(): McpTool[] {
    return [...this.#current().values()].map((offered) => offered.tool);
  }

  /** Run the fn behind a tool; `undefined` when there is no such tool. */
  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<McpToolResult | undefined> {
    const offered = this.#current().get(name);
    if (offered === undefined) { return undefined; }
    try {
      return textResult(JSON.stringify(await this.#run(offered.local, args, signal)));
    } catch (error) {
      return errorResult(messageOf(error));
    }
  }

  /** Fns added or removed at runtime change the tool list. */
  onChange(listener: () => void): () => void {
    return this.#table.onChange(listener);
  }

  /** Serve over stdin/stdout or Streamable HTTP. Resolves once listening (stdio serves until stdin ends). */
  async serve(how: McpServe): Promise<void> {
    if ('stdio' in how) {
      const input = createInterface({ input: process.stdin });
      void serveStdio(this.#server, { input, output: { write: (line) => { process.stdout.write(`${line}\n`); } } })
        .catch((error: unknown) => { this.#env.log.error('mcp.stdio-failed', { error: messageOf(error) }); });
      return;
    }
    const handler = mcpHttp(this.#server, { maxBody: this.#limits.maxBody });
    const server = createServer(createRequestListener(handler));
    this.#http = { server, handler };
    await new Promise<void>((resolve) => { server.listen(how.http.port, how.http.host ?? '0.0.0.0', resolve); });
    this.#env.log.info('mcp.listening', { port: how.http.port });
  }

  async close(): Promise<void> {
    const http = this.#http;
    this.#http = undefined;
    this.#server.close();
    if (http === undefined) { return; }
    http.handler.close();
    http.server.closeAllConnections();
    await new Promise<void>((resolve) => { http.server.close(() => { resolve(); }); });
  }

  /** The tools by name for the fns as they are now. */
  #current(): ReadonlyMap<string, Offered> {
    const fns = this.#natives();
    const built = this.#offered;
    const same = built !== undefined && fns.length === built.fns.length && fns.every(([local, def], i) => {
      const was = built.fns[i];
      return was !== undefined && was[0] === local && was[1] === def;
    });
    if (same) { return built.byTool; }
    const byTool = new Map(fns.map(([local, def]): [string, Offered] => {
      // the one fn name: an MCP client sees the name a chat model does
      const name = modelFnName(qualify(this.#table.contract.name, local));
      const inputSchema = z.toJSONSchema(def.args.toValueSchema({ includeDocs: 'all' }), { io: 'input', unrepresentable: 'any' });
      return [name, { local, tool: { name, description: def.description, inputSchema } }];
    }));
    this.#offered = { fns, byTool };
    return byTool;
  }

  /** The native fns offered to MCP clients: every one the LLM may see. */
  #natives(): Array<readonly [string, AnyFnDef]> {
    const locals = [...Object.keys(this.#table.contract.defs.fns), ...this.#table.added().keys()];
    return locals.flatMap((local) => {
      const def = this.#table.fnDef(local);
      return def !== undefined && def.kind === 'native' && (def.visibility === 'llm' || def.visibility === 'both') ? [[local, def] as const] : [];
    });
  }

  /** Run a fn locally for an MCP client; a client that goes away cancels it. */
  async #run(local: string, args: unknown, signal: AbortSignal): Promise<Json> {
    const target = this.#table.target(local, 'native');
    if (typeof target === 'string') { throw new Error(target); }
    const now = this.#env.now();
    const config = this.#env.currentConfig();
    if (config === undefined) { throw new Error('This system has no valid config yet.'); }
    const { user, time } = mcpAsker(now);
    const request: RunRequest = {
      run: {
        id: mintId('run'),
        fn: qualify(this.#table.contract.name, local),
        turn: mintId('turn'),
        user,
        time,
        system: { name: this.#table.contract.name, instance: MAIN_INSTANCE, boot: 'mcp' },
        caller: MCP_ACTOR,
        attempt: 1,
        priority: 'interactive',
      },
      fn: local,
      kind: 'native',
      args: Json.parse(args),
      budget: { cost: 0, time: this.#limits.timeout, limitedBy: 'mcp' },
      handlers: [],
      deadline: now + this.#limits.timeout,
      configVersion: config,
    };
    const run = new ActiveRun(request, target, this.#env);
    const cancel = (): void => { void run.control('cancel'); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const outcome = await run.outcome();
      switch (outcome.status) {
        case 'done': return outcome.result;
        case 'invalid-input': throw new Error(`The input was refused: ${problemsText(outcome.invalid)}`);
        case 'failed': throw new Error(outcome.error.message);
        case 'paused': throw new Error('The fn paused; MCP calls cannot be resumed.');
        case 'cancelled': throw new Error('The fn was cancelled.');
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
