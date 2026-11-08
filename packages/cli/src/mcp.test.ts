import type { JsonRpcNotification, JsonRpcOutgoingRequest, McpClientTransport, McpProtocolVersion } from '@ayepi/mcp';
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.ts';
import { bridge, linesOf } from './commands/mcp.ts';
import { testIo } from './testing.ts';

/** A transport that answers like a hub MCP and records what it was sent. */
class FakeTransport implements McpClientTransport {
  readonly requests: JsonRpcOutgoingRequest[] = [];
  readonly notes: JsonRpcNotification[] = [];
  opened_: McpProtocolVersion | undefined;
  listening = false;
  closed = false;
  #listener: ((message: unknown) => void) | undefined;

  request(message: JsonRpcOutgoingRequest): Promise<unknown> {
    this.requests.push(message);
    if (message.method === 'boom') { return Promise.reject(new Error('the hub went away')); }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'hub', version: '1' } }
      : { tools: [] };
    // the hub pushes a notification of its own while answering
    this.#listener?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    return Promise.resolve({ jsonrpc: '2.0', id: message.id, result });
  }
  notify(message: JsonRpcNotification): Promise<void> { this.notes.push(message); return Promise.resolve(); }
  onMessage(listener: (message: unknown) => void): () => void { this.#listener = listener; return () => { this.#listener = undefined; }; }
  opened(version: McpProtocolVersion): void { this.opened_ = version; }
  listen(): void { this.listening = true; }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

async function* lines(...items: string[]): AsyncGenerator<string> { yield* items; }

describe('the stdio bridge', () => {
  it('forwards requests with the client’s own ids, notifications, and the hub’s notifications', async () => {
    const transport = new FakeTransport();
    const out: string[] = [];
    await bridge(transport, lines(
      JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      '',
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      'not json',
      JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'boom' }),
      JSON.stringify({ nope: true }),
    ), { write: (line) => { out.push(line); } });
    const messages = out.map((line): unknown => JSON.parse(line));
    expect(transport.requests.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(transport.opened_).toBe('2025-06-18');
    expect(transport.listening).toBe(true);
    expect(transport.notes).toEqual([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(out.find((line) => line.includes('"id":"a"'))).toContain('"protocolVersion":"2025-06-18"');
    expect(messages).toContainEqual({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
    expect(messages).toContainEqual({ jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'the hub went away' } });
    expect(messages).toContainEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'that line is not JSON' } });
    expect(messages).toContainEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect(transport.closed).toBe(true);
  });

  it('splits a stream into lines', async () => {
    async function* chunks() { yield new TextEncoder().encode('{"a":1}\r\n{"b"'); yield ':2}\n'; yield 'tail'; }
    const got: string[] = [];
    for await (const line of linesOf(chunks())) { got.push(line); }
    expect(got).toEqual(['{"a":1}', '{"b":2}', 'tail']);
  });

  it('needs a slug and a secret', async () => {
    const io = testIo();
    expect(await runCli(['mcp'], io)).toBe(2);
    expect(await runCli(['mcp', 'claude'], io)).toBe(2);
  });
});
