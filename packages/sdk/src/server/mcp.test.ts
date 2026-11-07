/**
 * The MCP face: a system's native fns as MCP tools over Streamable HTTP (`@ayepi/mcp`), with field docs in their
 * input schemas, following runtime adds and removes and telling clients the list changed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

/** A port for this test's MCP server (above 4300, as the repo asks). */
const PORT = 4387;
const URL_ = `http://127.0.0.1:${PORT}/`;

const calc = system('calc', { description: 'Arithmetic.' }).with({
  fns: {
    add: fn({ description: 'Add two numbers.', args: g.obj({ a: g.field(g.num(), { docs: 'The first number.' }), b: g.num() }), returns: g.num() }),
    secret: fn({ description: 'Only for people.', args: g.obj({}), returns: g.text(), visibility: 'user' }),
  },
});

let running: RunningSystem<'calc'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function start(): Promise<void> {
  const hub = new FakeHub();
  running = await serve(calc, {
    fns: {
      add: { async run(args, ctx) { return ctx.done(args.a + args.b); } },
      secret: { async run(_a, ctx) { return ctx.done('shh'); } },
    },
  }, { hub: 'ws://hub.test/link', state: 'x', version: '2.0.0', mcp: { http: { port: PORT } } }, hub.host());
  await running.ready();
}

/** An MCP client session: `initialize`, then JSON-RPC calls carrying the session id. */
async function connect() {
  const init = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  const session = init.headers.get('mcp-session-id') ?? '';
  const headers = { 'content-type': 'application/json', 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' };
  const answer: unknown = await init.json();
  return {
    init: answer,
    headers,
    async rpc(method: string, params?: unknown): Promise<unknown> {
      const response = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }) });
      return response.json();
    },
  };
}

describe('the MCP face', () => {
  it('lists the fns the LLM may see as tools with documented JSON schema input, and runs them', async () => {
    await start();
    const client = await connect();
    expect(client.init).toMatchObject({
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'calc', version: '2.0.0' }, capabilities: { tools: { listChanged: true } }, instructions: 'Arithmetic.' },
    });
    expect(await client.rpc('tools/list')).toMatchObject({
      result: { tools: [{ name: 'calc_add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number', description: 'The first number.' } } } }] },
    });
    expect(await client.rpc('tools/call', { name: 'calc_add', arguments: { a: 2, b: 3 } })).toMatchObject({ result: { content: [{ type: 'text', text: '5' }] } });
    expect(await client.rpc('tools/call', { name: 'calc_add', arguments: { a: 'x' } })).toMatchObject({ result: { isError: true } });
    expect(await client.rpc('tools/call', { name: 'calc_secret', arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(await client.rpc('nope')).toMatchObject({ error: { code: -32601 } });
  });

  it('follows runtime adds and removes, and tells open event streams the list changed', async () => {
    await start();
    const client = await connect();
    const events = await fetch(URL_, { headers: { ...client.headers, accept: 'text/event-stream' } });
    const reader = events.body?.getReader();
    if (running === undefined || reader === undefined) { throw new Error('not started'); }

    const twice = await running.add('twice', fn({ description: 'Double it.', args: g.obj({ n: g.num() }), returns: g.num() }), { async run(args, ctx) { return ctx.done(args.n * 2); } });
    // the stream opens with a comment, then carries the notification
    let heard = '';
    while (!heard.includes('list_changed')) { heard += new TextDecoder().decode((await reader.read()).value); }
    expect(heard).toContain('notifications/tools/list_changed');
    expect(await client.rpc('tools/call', { name: 'calc_twice', arguments: { n: 4 } })).toMatchObject({ result: { content: [{ text: '8' }] } });

    await running.remove(twice);
    expect(await client.rpc('tools/call', { name: 'calc_twice', arguments: { n: 4 } })).toMatchObject({ error: { code: -32602 } });
    await running.add('twice', fn({ description: 'Triple it, now.', args: g.obj({ n: g.num() }), returns: g.num() }), { async run(args, ctx) { return ctx.done(args.n * 3); } });
    expect(await client.rpc('tools/list')).toMatchObject({ result: { tools: [{ name: 'calc_add' }, { name: 'calc_twice', description: 'Triple it, now.' }] } });
    expect(await client.rpc('tools/call', { name: 'calc_twice', arguments: { n: 4 } })).toMatchObject({ result: { content: [{ text: '12' }] } });
    await reader.cancel();
  });

  it('answers HTTP edge cases: other methods, notifications, no session, bad JSON and bad requests', async () => {
    await start();
    const client = await connect();
    expect((await fetch(URL_, { method: 'PUT' })).status).toBe(405);
    expect((await fetch(URL_)).status).toBe(405);
    expect((await fetch(URL_, { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status).toBe(202);
    expect((await fetch(URL_, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).status).toBe(400);
    expect(await (await fetch(URL_, { method: 'POST', headers: client.headers, body: '{nope' })).json()).toMatchObject({ error: { code: -32700 } });
    expect(await (await fetch(URL_, { method: 'POST', headers: client.headers, body: JSON.stringify({ hello: 1 }) })).json()).toMatchObject({ error: { code: -32600 } });
    expect((await fetch(URL_, { method: 'POST', headers: client.headers, body: 'x'.repeat(2_000_000) })).status).toBe(413);
  });
});
