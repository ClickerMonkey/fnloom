/**
 * `harness mcp <slug> --secret <secret>`: bridge a hub MCP to stdin and stdout, for MCP clients that only speak stdio.
 * Each JSON-RPC line read is sent to the hub MCP's Streamable HTTP endpoint (`<hub>/mcp/<slug>`) and its answer
 * written back as a line; the hub's own notifications are written as they come. Request ids are mapped, so a client's
 * string ids work over the transport's numeric ones.
 */
import { JsonRpcRequest, JsonRpcResponseMessage, McpHttpClientTransport, McpInitializeResult, isProtocolVersion, rpcError, type LineReader, type LineWriter, type McpClientTransport } from '@ayepi/mcp';
import { McpSlug } from '@harness/core';
import { z } from 'zod';
import { HUB_OPTIONS, command } from '../command.ts';
import { hubTarget } from '../hub.ts';

/** The JSON-RPC error code for a request the bridge couldn't deliver. */
const BRIDGE_ERROR = -32603;

/** Bridge newline-delimited JSON-RPC between a stdio pair and a client transport, until the input ends. */
export async function bridge(transport: McpClientTransport, input: LineReader, output: LineWriter): Promise<void> {
  const stop = transport.onMessage((message) => { void output.write(JSON.stringify(message)); });
  const pending: Array<Promise<void>> = [];
  let next = 0;
  try {
    for await (const line of input) {
      if (line.trim() === '') { continue; }
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { await output.write(JSON.stringify(rpcError(null, -32700, 'that line is not JSON'))); continue; }
      const message = JsonRpcRequest.safeParse(raw);
      if (!message.success) { continue; }
      const { id, method, params } = message.data;
      if (id === undefined || id === null) {
        pending.push(transport.notify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }).catch(() => undefined));
        // the handshake is done: the hub's own notifications can flow
        if (method === 'notifications/initialized') { transport.listen(); }
        continue;
      }
      next += 1;
      const wire = next;
      pending.push((async () => {
        try {
          const answer = JsonRpcResponseMessage.parse(await transport.request({ jsonrpc: '2.0', id: wire, method, ...(params === undefined ? {} : { params }) }, new AbortController().signal));
          if (method === 'initialize') {
            const result = McpInitializeResult.safeParse(answer.result);
            if (result.success && isProtocolVersion(result.data.protocolVersion)) { transport.opened(result.data.protocolVersion); }
          }
          await output.write(JSON.stringify({ ...answer, id }));
        } catch (error) {
          await output.write(JSON.stringify(rpcError(id, BRIDGE_ERROR, error instanceof Error ? error.message : String(error))));
        }
      })());
    }
    await Promise.all(pending);
  } finally {
    stop();
    await transport.close();
  }
}

/** Lines of a readable stream (stdin). */
export async function* linesOf(stream: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    yield* lines;
  }
  if (buffered !== '') { yield buffered; }
}

export const mcpCommand = command({
  path: ['mcp'],
  summary: 'Bridge a hub MCP to stdin and stdout, for MCP clients that speak stdio only.',
  usage: '<slug> --secret <secret>',
  args: z.object({ positionals: z.tuple([McpSlug]), values: z.object({ hub: HUB_OPTIONS.hub, secret: z.string().min(1) }) }),
  async run({ positionals: [slug], values }, io) {
    const target = hubTarget(io.settings, values);
    const transport = new McpHttpClientTransport(`${target.url}/mcp/${slug}`, { headers: { authorization: `Bearer ${values.secret}` } });
    await bridge(transport, io.stdin(), { write: (line) => { io.out.line(line); } });
    return 0;
  },
});
