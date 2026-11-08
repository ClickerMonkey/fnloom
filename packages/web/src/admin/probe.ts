/**
 * Trying a hub MCP from the browser, as an MCP client would: initialize over streamable HTTP with the MCP's secret,
 * then list its tools, so an admin sees the rules work before handing the secret to anyone. An answer may come as
 * JSON or as a server-sent event; both are read with one schema. `McpProbe` is the interface; tests use a fake.
 */
import { z } from 'zod';

/** What a probe found: the server's name and version, and each tool it offers. */
export const ProbeResult = z.object({
  server: z.object({ name: z.string(), version: z.string() }),
  instructions: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

/** Tries an MCP endpoint. */
export interface McpProbe {
  /** Initialize at `url` with `secret` and list the tools; rejects with a plain sentence when it can't. */
  tools(url: string, secret: string): Promise<ProbeResult>;
}

/** The MCP protocol version the probe speaks. */
export const PROBE_PROTOCOL = '2025-06-18';

/** A JSON-RPC answer: a result, or an error. */
const RpcAnswer = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]), result: z.unknown() }),
  z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string(), z.null()]), error: z.object({ code: z.number(), message: z.string() }) }),
]);

const InitializeResult = z.object({ serverInfo: z.object({ name: z.string(), version: z.string() }), instructions: z.string().optional() });
const ListToolsResult = z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() })) });

/** The JSON of an answer that came as JSON or as server-sent events (the last `data:` line that parses). */
export function answerJson(contentType: string, body: string): unknown {
  if (!contentType.includes('text/event-stream')) { return JSON.parse(body); }
  const datas = body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter((line) => line !== '');
  for (const data of datas.reverse()) {
    try { return JSON.parse(data); } catch { /* a partial event; try the one before */ }
  }
  throw new Error('The MCP sent no answer.');
}

/** Probes with the browser's `fetch`. */
export class HttpMcpProbe implements McpProbe {
  readonly #fetch: (url: string, init: RequestInit) => Promise<Response>;

  constructor(fetcher: (url: string, init: RequestInit) => Promise<Response>) {
    this.#fetch = fetcher;
  }

  async tools(url: string, secret: string): Promise<ProbeResult> {
    let session: string | undefined;
    const send = async (id: number | undefined, method: string, params: Record<string, unknown>): Promise<unknown> => {
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${secret}`,
          'mcp-protocol-version': PROBE_PROTOCOL, ...(session === undefined ? {} : { 'mcp-session-id': session }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }),
      });
      if (response.status === 401 || response.status === 403) { throw new Error('The MCP refused that secret.'); }
      if (!response.ok && response.status !== 202) { throw new Error(`The MCP answered ${response.status}.`); }
      session = response.headers.get('mcp-session-id') ?? session;
      if (id === undefined) { return undefined; }
      const answer = RpcAnswer.parse(answerJson(response.headers.get('content-type') ?? '', await response.text()));
      if ('error' in answer) { throw new Error(answer.error.message); }
      return answer.result;
    };
    const init = InitializeResult.parse(await send(1, 'initialize', { protocolVersion: PROBE_PROTOCOL, capabilities: {}, clientInfo: { name: 'harness-admin', version: '1' } }));
    await send(undefined, 'notifications/initialized', {});
    const listed = ListToolsResult.parse(await send(2, 'tools/list', {}));
    return ProbeResult.parse({ server: init.serverInfo, ...(init.instructions === undefined ? {} : { instructions: init.instructions }), tools: listed.tools });
  }
}
