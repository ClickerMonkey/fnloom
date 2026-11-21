import {
  McpMemoryClientTransport, mcpSourceServer, textResult,
  type McpPromptSource, type McpResourceSource, type McpServer, type McpTool, type McpToolSource,
} from '@ayepi/mcp';
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';
import { bridge, linesOf } from './commands/mcp.ts';
import { ENV_FILE_URL_REFUSED } from './hub.ts';
import { testIo } from './testing.ts';

/** Lines fed one at a time, so a test can write after it has seen an answer; `end` closes the input. */
class LineQueue implements AsyncIterable<string> {
  readonly #lines: string[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(message: unknown): void {
    this.#lines.push(typeof message === 'string' ? message : JSON.stringify(message));
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) { yield line; continue; }
      if (this.#ended) { return; }
      await new Promise<void>((resolve) => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

/** What the bridge wrote, parsed, with a wait for a message that fits. */
class Written {
  readonly messages: unknown[] = [];
  readonly #waiting = new Set<() => void>();

  write = (line: string): void => {
    this.messages.push(JSON.parse(line));
    for (const wake of [...this.#waiting]) { wake(); }
  };

  /** The first message matching `fits`, once written. */
  async next(fits: (message: unknown) => boolean): Promise<unknown> {
    for (;;) {
      const found = this.messages.find(fits);
      if (found !== undefined) { return found; }
      await new Promise<void>((resolve) => {
        const wake = (): void => { this.#waiting.delete(wake); resolve(); };
        this.#waiting.add(wake);
      });
    }
  }
}

/** Whether a message is the answer with an id. */
const answerTo = (id: string | number | null) => (message: unknown): boolean => typeof message === 'object' && message !== null && 'id' in message && message.id === id && !('method' in message);

const ECHO: McpTool = { name: 'echo', inputSchema: { type: 'object' } };
const SLOW: McpTool = { name: 'slow', inputSchema: { type: 'object' } };

/** A stand-in hub MCP: an echo tool, a tool that runs until it is cancelled, one resource and one prompt. */
function fakeHub() {
  const seen: { aborted: string[]; started: string[] } = { aborted: [], started: [] };
  let tools: McpTool[] = [ECHO, SLOW];
  const changes = new Set<() => void>();
  const toolSource: McpToolSource = {
    tools: () => tools,
    call(name, args, signal) {
      if (name === 'echo') { return Promise.resolve(textResult(JSON.stringify(args))); }
      if (name !== 'slow') { return Promise.resolve(undefined); }
      seen.started.push(name);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { seen.aborted.push(name); reject(new Error('cancelled')); }, { once: true });
      });
    },
    onChange: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
  };
  const resources: McpResourceSource = {
    list: () => Promise.resolve({ resources: [{ uri: 'hub://a', name: 'a' }] }),
    templates: () => [{ uriTemplate: 'hub://{id}', name: 'any' }],
    read: (uri) => Promise.resolve(uri === 'hub://a' ? [{ uri, text: 'A' }] : undefined),
  };
  const prompts: McpPromptSource = {
    prompts: () => [{ name: 'hello' }],
    get: (name) => Promise.resolve(name === 'hello' ? { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] } : undefined),
  };
  const server: McpServer = mcpSourceServer({ tools: toolSource, resources, prompts }, { serverInfo: { name: 'hub', version: '9' }, instructions: 'use the tools' });
  const changeTools = (next: McpTool[]): void => { tools = next; for (const listener of [...changes]) { listener(); } };
  return { server, seen, changeTools };
}

/** Run the bridge over a fresh fake hub, with the stdio client's handshake done. */
async function bridged() {
  const hub = fakeHub();
  const input = new LineQueue();
  const output = new Written();
  const done = bridge(new McpMemoryClientTransport(hub.server), input, output);
  input.push({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } });
  const init = await output.next(answerTo('init'));
  input.push({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { hub, input, output, done, init };
}

describe('the stdio bridge', () => {
  it('answers the handshake as the hub, with the client’s own ids', async () => {
    const { input, done, init } = await bridged();
    expect(init).toMatchObject({ id: 'init', result: { protocolVersion: '2025-06-18', serverInfo: { name: 'hub', version: '9' }, instructions: 'use the tools' } });
    expect(init).toMatchObject({ result: { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } } });
    input.end();
    await done;
  });

  it('lists and calls tools, and answers an unknown tool as bad params', async () => {
    const { input, output, done } = await bridged();
    input.push({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    input.push({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
    input.push({ jsonrpc: '2.0', id: 'nope', method: 'tools/call', params: { name: 'missing', arguments: {} } });
    expect(await output.next(answerTo(7))).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [ECHO, SLOW] } });
    expect(await output.next(answerTo('call'))).toMatchObject({ result: { content: [{ type: 'text', text: '{"a":1}' }] } });
    expect(await output.next(answerTo('nope'))).toMatchObject({ error: { code: -32602 } });
    input.end();
    await done;
  });

  it('passes a cancel through to the hub call it names, though the ids differ', async () => {
    const { hub, input, output, done } = await bridged();
    input.push({ jsonrpc: '2.0', id: 'long', method: 'tools/call', params: { name: 'slow', arguments: {} } });
    await expect.poll(() => hub.seen.started).toEqual(['slow']);
    input.push({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'long', reason: 'user stopped it' } });
    await expect.poll(() => hub.seen.aborted).toEqual(['slow']);
    input.end();
    await done;
    expect(output.messages.filter(answerTo('long'))).toHaveLength(1);
  });

  it('forwards the hub’s tool list changes, with the new list', async () => {
    const { hub, input, output, done } = await bridged();
    hub.changeTools([ECHO]);
    await output.next((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'notifications/tools/list_changed');
    input.push({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(await output.next(answerTo(1))).toMatchObject({ result: { tools: [ECHO] } });
    input.end();
    await done;
  });

  it('proxies resources and prompts, and their not-found answers', async () => {
    const { input, output, done } = await bridged();
    input.push({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    input.push({ jsonrpc: '2.0', id: 2, method: 'resources/templates/list' });
    input.push({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'hub://a' } });
    input.push({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'hub://b' } });
    input.push({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
    input.push({ jsonrpc: '2.0', id: 6, method: 'prompts/get', params: { name: 'hello' } });
    input.push({ jsonrpc: '2.0', id: 7, method: 'prompts/get', params: { name: 'bye' } });
    expect(await output.next(answerTo(1))).toMatchObject({ result: { resources: [{ uri: 'hub://a' }] } });
    expect(await output.next(answerTo(2))).toMatchObject({ result: { resourceTemplates: [{ uriTemplate: 'hub://{id}' }] } });
    expect(await output.next(answerTo(3))).toMatchObject({ result: { contents: [{ uri: 'hub://a', text: 'A' }] } });
    expect(await output.next(answerTo(4))).toMatchObject({ error: { code: -32002 } });
    expect(await output.next(answerTo(5))).toMatchObject({ result: { prompts: [{ name: 'hello' }] } });
    expect(await output.next(answerTo(6))).toMatchObject({ result: { messages: [{ role: 'user' }] } });
    expect(await output.next(answerTo(7))).toMatchObject({ error: { code: -32602 } });
    input.end();
    await done;
  });

  it('answers a line that is not JSON with a parse error and skips blank lines', async () => {
    const { input, output, done } = await bridged();
    input.push('');
    input.push('not json');
    expect(await output.next(answerTo(null))).toMatchObject({ error: { code: -32700 } });
    input.end();
    await done;
  });

  it('splits a stream into lines', async () => {
    async function* chunks() { yield new TextEncoder().encode('{"a":1}\r\n{"b"'); yield ':2}\n'; yield 'tail'; }
    const got: string[] = [];
    for await (const line of linesOf(chunks())) { got.push(line); }
    expect(got).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });

  it('needs a slug and a secret, from HARNESS_MCP_SECRET (stdin is the MCP stream)', async () => {
    const io = testIo();
    expect(await runCli(['mcp'], io)).toBe(2);
    expect(await runCli(['mcp', 'claude'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('Set HARNESS_MCP_SECRET');
    expect(await runCli(['mcp', 'claude', '--secret', '-'], io)).toBe(1);
    expect(io.warnings.at(-1)).toContain('set HARNESS_MCP_SECRET');
  });

  it('warns that a --secret on the command line can be seen, and never sends one to a hub address from the folder’s .env', async () => {
    const io = testIo();
    const fromFile = { ...io, settings: { ...io.settings, HARNESS_URL: 'http://attacker.example:4300', fromFile: new Set(['HARNESS_URL'] as const) } };
    expect(await runCli(['mcp', 'claude', '--secret', 'typed'], fromFile)).toBe(1);
    expect(io.warnings).toEqual([expect.stringContaining('--secret on the command line can be seen by other programs'), ENV_FILE_URL_REFUSED]);
  });
});
