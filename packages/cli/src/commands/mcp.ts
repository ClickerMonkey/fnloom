/**
 * `harness mcp <slug>`: bridge a hub MCP to stdin and stdout, for MCP clients that only speak stdio. Its secret is
 * `HARNESS_MCP_SECRET` in the environment the MCP client starts it with (`--secret <secret>` works, with a warning: other
 * programs can see it; stdin is the MCP stream, so it can't come from there).
 * The bridge is built from `@ayepi/mcp` parts: an {@link McpClient} connected to the hub MCP's Streamable HTTP endpoint
 * (`<hub>/mcp/<slug>`), offered again as an `mcpSourceServer` whose tools, resources and prompts are the hub's
 * ({@link proxySources}), driven over the stdio lines. The local server keeps the stdio client's request ids and the
 * client keeps its own toward the hub, so a `notifications/cancelled` from the stdio client aborts the local call,
 * whose signal makes the client send `notifications/cancelled` for its own id: cancelling reaches the hub run.
 */
import {
  JSON_RPC_ERRORS, McpClient, McpError, mcpSourceServer, McpHttpClientTransport, rpcError,
  type LineReader, type LineWriter, type McpClientTransport, type McpImplementation, type McpNotice, type McpPrompt,
  type McpPromptSource, type McpResourceSource, type McpServer, type McpSources, type McpTool, type McpToolSource,
} from '@ayepi/mcp';
import { McpSlug } from '@harness/core';
import { z } from 'zod';
import { HUB_OPTIONS, command } from '../command.ts';
import { hubTarget, secretOption } from '../hub.ts';

/** Who the bridge says it is to the hub. */
export const BRIDGE_CLIENT: McpImplementation = { name: 'harness-cli', version: '0.0.0' };

/** Whether an error is the remote's answer with one JSON-RPC code. */
function answeredWith(error: unknown, code: number): boolean {
  return error instanceof McpError && error.code === code;
}

/** Hear one notification method from the remote. */
function onNotice(client: McpClient, method: string, listener: (notice: McpNotice) => void): () => void {
  return client.onNotification((notice) => { if (notice.method === method) { listener(notice); } });
}

/** A list the remote offers, kept current: read once, read again on its `list_changed` notification. */
class RemoteList<T> {
  #items: readonly T[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #read: () => Promise<readonly T[]>;

  constructor(client: McpClient, changed: string, read: () => Promise<readonly T[]>) {
    this.#read = read;
    onNotice(client, changed, () => { void this.refresh().then(() => { for (const listener of [...this.#listeners]) { listener(); } }, () => undefined); });
  }

  /** The items as last read. */
  get items(): readonly T[] {
    return this.#items;
  }

  /** Read the list again. */
  async refresh(): Promise<void> {
    this.#items = await this.#read();
  }

  /** Hear the list change. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
}

/**
 * The sources of a local MCP server that answer from a connected client: each capability the remote advertised, with
 * its lists kept current and each call made with the local call's signal (so cancelling one cancels the other).
 */
export async function proxySources(client: McpClient): Promise<McpSources> {
  const capabilities = client.server.capabilities;
  let tools: McpToolSource | undefined;
  if (capabilities.tools !== undefined) {
    const list = new RemoteList<McpTool>(client, 'notifications/tools/list_changed', () => client.listTools());
    await list.refresh();
    tools = {
      tools: () => list.items,
      async call(name, args, signal) {
        try {
          return await client.callTool(name, args, { signal });
        } catch (error) {
          if (answeredWith(error, JSON_RPC_ERRORS.invalidParams)) { return undefined; }
          throw error;
        }
      },
      onChange: (listener) => list.onChange(listener),
    };
  }
  let resources: McpResourceSource | undefined;
  if (capabilities.resources !== undefined) {
    const changes = new Set<() => void>();
    onNotice(client, 'notifications/resources/list_changed', () => { for (const listener of [...changes]) { listener(); } });
    resources = {
      list: (cursor, signal) => client.request('resources/list', cursor === undefined ? {} : { cursor }, { signal }),
      templates: (signal) => client.listResourceTemplates({ signal }),
      async read(uri, signal) {
        try {
          return await client.readResource(uri, { signal });
        } catch (error) {
          if (answeredWith(error, JSON_RPC_ERRORS.resourceNotFound)) { return undefined; }
          throw error;
        }
      },
      ...(capabilities.resources.subscribe === true ? {
        watch(uri: string, onUpdate: () => void): () => void {
          const stop = onNotice(client, 'notifications/resources/updated', (notice) => {
            const updated = z.object({ uri: z.string() }).safeParse(notice.params);
            if (updated.success && updated.data.uri === uri) { onUpdate(); }
          });
          void client.subscribe(uri).catch(() => undefined);
          return () => { stop(); void client.unsubscribe(uri).catch(() => undefined); };
        },
      } : {}),
      onChange(listener) { changes.add(listener); return () => { changes.delete(listener); }; },
    };
  }
  let prompts: McpPromptSource | undefined;
  if (capabilities.prompts !== undefined) {
    const list = new RemoteList<McpPrompt>(client, 'notifications/prompts/list_changed', () => client.listPrompts());
    await list.refresh();
    prompts = {
      prompts: () => list.items,
      async get(name, args, signal) {
        try {
          return await client.getPrompt(name, args, { signal });
        } catch (error) {
          if (answeredWith(error, JSON_RPC_ERRORS.invalidParams)) { return undefined; }
          throw error;
        }
      },
      onChange: (listener) => list.onChange(listener),
    };
  }
  return { ...(tools === undefined ? {} : { tools }), ...(resources === undefined ? {} : { resources }), ...(prompts === undefined ? {} : { prompts }) };
}

/**
 * Drive a server over newline-delimited JSON, answering requests as they finish rather than in turn, so a
 * notification (above all `notifications/cancelled`) reaches the server while an earlier call still runs. Resolves
 * once the input ends and every answer is written. (`serveStdio` answers one line at a time; see the library ask in
 * build-2-design.md §8.)
 */
export async function serveLines(server: McpServer, input: LineReader, output: LineWriter): Promise<void> {
  const stop = server.onNotification((message) => { void output.write(JSON.stringify(message)); });
  const answering = new Set<Promise<void>>();
  try {
    for await (const line of input) {
      if (line.trim() === '') { continue; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { await output.write(JSON.stringify(rpcError(null, JSON_RPC_ERRORS.parse, 'that line is not JSON'))); continue; }
      const answer = server.handle(message).then(async (response) => { if (response !== null) { await output.write(JSON.stringify(response)); } });
      answering.add(answer);
      void answer.finally(() => { answering.delete(answer); });
    }
    await Promise.all(answering);
  } finally {
    stop();
    server.close();
  }
}

/** Bridge a hub MCP reached over `transport` to a stdio pair, until the input ends. */
export async function bridge(transport: McpClientTransport, input: LineReader, output: LineWriter): Promise<void> {
  const client = await McpClient.connect(transport, { clientInfo: BRIDGE_CLIENT });
  try {
    const { serverInfo, instructions } = client.server;
    const server = mcpSourceServer(await proxySources(client), { serverInfo, ...(instructions === undefined ? {} : { instructions }) });
    await serveLines(server, input, output);
  } finally {
    await client.close();
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
  usage: '<slug> [--hub <url>] (the secret in HARNESS_MCP_SECRET)',
  args: z.object({ positionals: z.tuple([McpSlug]), values: z.object({ hub: HUB_OPTIONS.hub, secret: z.string().min(1).optional() }) }),
  async run({ positionals: [slug], values }, io) {
    // stdin is the MCP stream: the secret comes from the environment, or (with a warning) the command line
    const given = await secretOption(values.secret, io, { flag: '--secret', env: 'HARNESS_MCP_SECRET', stdin: false });
    const secret = given ?? io.settings.HARNESS_MCP_SECRET;
    if (secret === undefined) { throw new Error('Set HARNESS_MCP_SECRET to the secret of the hub MCP, in the environment the MCP client starts this with.'); }
    const target = hubTarget(io.settings, values, { fromFile: given === undefined && io.settings.fromFile.has('HARNESS_MCP_SECRET') });
    const transport = new McpHttpClientTransport(`${target.url}/mcp/${slug}`, { headers: { authorization: `Bearer ${secret}` } });
    await bridge(transport, io.stdin(), { write: (line) => { io.out.line(line); } });
    return 0;
  },
});
