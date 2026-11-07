/**
 * A system as an MCP server, with no extra code. Its native fns become MCP tools (`<system>_<fn>`), through
 * `@ayepi/mcp`'s `McpServer` and its stdio transport. A tool's input schema is the fn's args as a value schema from gin,
 * as JSON schema. A fn added or removed at runtime rebuilds the tool list. (ayepi's `mcpServer` serves a static ayepi
 * spec; fns are gin-typed and change at runtime, so the face answers the three JSON-RPC methods itself.)
 *
 * MCP calls run here, as local runs on behalf of the MCP client: args and results are checked as usual, but nothing
 * goes through the hub's queue, so a fn whose run calls other fns, the hub's LLM or session state needs the hub link.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { serveStdio, type McpServer, type McpTool } from '@ayepi/mcp';
import { ActorId, Json, mintId, qualify, type RunRequest } from '@harness/core';
import { z } from 'zod';
import type { AnyFnDef } from '../fn.ts';
import type { McpServe } from './index.ts';
import { ActiveRun, type RunEnvironment } from './run.ts';
import type { SystemTable } from './table.ts';
import { messageOf } from './wire.ts';

/** The actor MCP calls run as. */
const MCP_ACTOR = ActorId.parse('act_mcp');

/** The MCP protocol version this face speaks. */
const MCP_PROTOCOL = '2024-11-05';

const JsonRpcRequest = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number(), z.null()]).optional(), method: z.string(), params: z.unknown().optional() });
const ToolCall = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });

/** A fn's MCP tool name (MCP tool names allow letters, digits, `_` and `-`). */
function toolName(local: string): string {
  return local.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The system's MCP server. */
export class McpFace {
  readonly #table: SystemTable;
  readonly #env: RunEnvironment;
  readonly #version: string;
  /** How long an MCP call may run. */
  readonly #timeout: number;
  #server: McpServer | undefined;
  #http: HttpServer | undefined;
  /** The fns the current server was built over, to rebuild when one is added, removed or replaced. */
  #built: ReadonlyArray<readonly [string, AnyFnDef]> = [];

  constructor(table: SystemTable, env: RunEnvironment, version: string, timeout: number) {
    this.#timeout = timeout;
    this.#table = table;
    this.#env = env;
    this.#version = version;
  }

  /** The tools offered now. */
  tools(): McpTool[] {
    return this.#current().tools();
  }

  /** Handle one JSON-RPC request (`initialize`, `tools/list`, `tools/call`); `null` for notifications. */
  handle(request: unknown): Promise<unknown> {
    return this.#current().handle(request);
  }

  /** Serve over stdin/stdout or HTTP. Resolves once listening (stdio serves until stdin ends). */
  async serve(how: McpServe): Promise<void> {
    if ('stdio' in how) {
      const input = createInterface({ input: process.stdin });
      void serveStdio({ tools: () => this.tools(), handle: (request) => this.handle(request) }, {
        input,
        output: { write: (line) => { process.stdout.write(`${line}\n`); } },
      }).catch((error: unknown) => { this.#env.log.error('mcp.stdio-failed', { error: messageOf(error) }); });
      return;
    }
    const http = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          let reply: unknown;
          try {
            reply = await this.handle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
          }
          if (reply === null) {
            res.writeHead(202).end();
          } else {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
          }
        })();
      });
    });
    this.#http = http;
    await new Promise<void>((resolve) => { http.listen(how.http.port, how.http.host ?? '0.0.0.0', resolve); });
    this.#env.log.info('mcp.listening', { port: how.http.port });
  }

  async close(): Promise<void> {
    const http = this.#http;
    this.#http = undefined;
    if (http !== undefined) { await new Promise<void>((resolve) => { http.close(() => { resolve(); }); }); }
  }

  /** The MCP server for the fns as they are now, rebuilt when they change. */
  #current(): McpServer {
    const natives = this.#natives();
    const same = natives.length === this.#built.length && natives.every(([local, def], i) => {
      const built = this.#built[i];
      return built !== undefined && built[0] === local && built[1] === def;
    });
    if (this.#server === undefined || !same) {
      this.#server = this.#build(natives);
      this.#built = natives;
    }
    return this.#server;
  }

  /** The native fns offered to MCP clients: every one the LLM may see. */
  #natives(): Array<readonly [string, AnyFnDef]> {
    const locals = [...Object.keys(this.#table.contract.defs.fns), ...this.#table.added().keys()];
    return locals.flatMap((local) => {
      const def = this.#table.fnDef(local);
      return def !== undefined && def.kind === 'native' && (def.visibility === 'llm' || def.visibility === 'both') ? [[local, def] as const] : [];
    });
  }

  /** An MCP server (JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`) over these fns. */
  #build(natives: Array<readonly [string, AnyFnDef]>): McpServer {
    const prefix = `${this.#table.contract.name}_`;
    const byTool = new Map(natives.map(([local, def]) => [prefix + toolName(local), { local, def }]));
    const tools: McpTool[] = [...byTool].map(([name, { def }]) => ({
      name,
      description: def.description,
      inputSchema: z.toJSONSchema(def.args.toValueSchema(), { io: 'input', unrepresentable: 'any' }),
    }));
    const info = { name: this.#table.contract.name, version: this.#version };
    return {
      tools: () => tools,
      handle: async (raw) => {
        const request = JsonRpcRequest.safeParse(raw);
        if (!request.success) { return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid JSON-RPC request' } }; }
        const { id, method, params } = request.data;
        if (id === undefined) { return null; }
        switch (method) {
          case 'initialize': return { jsonrpc: '2.0', id, result: { protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: info } };
          case 'tools/list': return { jsonrpc: '2.0', id, result: { tools } };
          case 'tools/call': {
            const call = ToolCall.safeParse(params);
            const tool = call.success ? byTool.get(call.data.name) : undefined;
            if (!call.success || tool === undefined) { return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${call.success ? call.data.name : ''}` } }; }
            try {
              const result = await this.#call(tool.local, call.data.arguments ?? {});
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
            } catch (error) {
              return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: messageOf(error) }], isError: true } };
            }
          }
          default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
        }
      },
    };
  }

  /** Run a fn locally for an MCP client. */
  async #call(local: string, args: unknown): Promise<Json> {
    const target = this.#table.target(local, 'native');
    if (typeof target === 'string') { throw new Error(target); }
    const now = this.#env.now();
    const config = this.#configVersion();
    const request: RunRequest = {
      run: {
        id: mintId('run'),
        fn: qualify(this.#table.contract.name, local),
        turn: mintId('turn'),
        user: { id: MCP_ACTOR, name: 'MCP client', email: '', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' },
        time: { now, timeZone: 'UTC', local: new Date(now).toISOString() },
        system: { name: this.#table.contract.name, instance: 'mcp' },
        caller: MCP_ACTOR,
        attempt: 1,
        priority: 'interactive',
      },
      fn: local,
      kind: 'native',
      args: Json.parse(args),
      budget: { cost: 0, time: this.#timeout, limitedBy: 'mcp' },
      handlers: [],
      deadline: now + this.#timeout,
      configVersion: config,
    };
    const outcome = await new ActiveRun(request, target, this.#env).outcome();
    switch (outcome.status) {
      case 'done': return outcome.result;
      case 'failed': throw new Error(outcome.error.message);
      case 'paused': throw new Error('The fn paused; MCP calls cannot be resumed.');
      case 'cancelled': throw new Error('The fn was cancelled.');
    }
  }

  #configVersion(): number {
    const version = this.#env.currentConfig();
    if (version === undefined) { throw new Error('This system has no valid config yet.'); }
    return version;
  }
}
