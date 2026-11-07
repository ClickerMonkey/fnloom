/** The MCP face: a system's native fns as MCP tools over HTTP, following runtime adds. */
import { afterEach, describe, expect, it } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

/** A port for this test's MCP server (above 4300, as the repo asks). */
const PORT = 4387;

const calc = system('calc', { description: 'Arithmetic.' }).with({
  fns: {
    add: fn({ description: 'Add two numbers.', args: g.obj({ a: g.num(), b: g.num() }), returns: g.num() }),
    secret: fn({ description: 'Only for people.', args: g.obj({}), returns: g.text(), visibility: 'user' }),
  },
});

let running: RunningSystem<'calc'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function rpc(method: string, params?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return response.json();
}

describe('the MCP face', () => {
  it('lists the fns the LLM may see as tools with JSON schema input, and runs them', async () => {
    const hub = new FakeHub();
    running = await serve(calc, {
      fns: {
        add: { async run(args, ctx) { return ctx.done(args.a + args.b); } },
        secret: { async run(_a, ctx) { return ctx.done('shh'); } },
      },
    }, { hub: 'ws://hub.test/link', state: 'x', version: '2.0.0', mcp: { http: { port: PORT } } }, hub.host());
    await running.ready();

    expect(await rpc('initialize')).toMatchObject({ result: { serverInfo: { name: 'calc', version: '2.0.0' }, capabilities: { tools: {} } } });
    const list = await rpc('tools/list');
    expect(list).toMatchObject({ result: { tools: [{ name: 'calc_add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }] } });
    expect(await rpc('tools/call', { name: 'calc_add', arguments: { a: 2, b: 3 } })).toMatchObject({ result: { content: [{ type: 'text', text: '5' }] } });
    expect(await rpc('tools/call', { name: 'calc_add', arguments: { a: 'x' } })).toMatchObject({ result: { isError: true } });
    expect(await rpc('tools/call', { name: 'calc_secret', arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(await rpc('nope')).toMatchObject({ error: { code: -32601 } });

    const twice = await running.add('twice', fn({ description: 'Double it.', args: g.obj({ n: g.num() }), returns: g.num() }), { async run(args, ctx) { return ctx.done(args.n * 2); } });
    expect(await rpc('tools/call', { name: 'calc_twice', arguments: { n: 4 } })).toMatchObject({ result: { content: [{ text: '8' }] } });

    await running.remove(twice);
    expect(await rpc('tools/call', { name: 'calc_twice', arguments: { n: 4 } })).toMatchObject({ error: { code: -32602 } });
    await running.add('twice', fn({ description: 'Triple it, now.', args: g.obj({ n: g.num() }), returns: g.num() }), { async run(args, ctx) { return ctx.done(args.n * 3); } });
    expect(await rpc('tools/list')).toMatchObject({ result: { tools: [{ name: 'calc_add' }, { name: 'calc_twice', description: 'Triple it, now.' }] } });
    expect(await rpc('tools/call', { name: 'calc_twice', arguments: { n: 4 } })).toMatchObject({ result: { content: [{ text: '12' }] } });
  });

  it('answers HTTP edge cases: other methods, notifications, bad JSON and bad requests', async () => {
    const hub = new FakeHub();
    running = await serve(calc, {
      fns: {
        add: { async run(args, ctx) { return ctx.done(args.a + args.b); } },
        secret: { async run(_a, ctx) { return ctx.done('shh'); } },
      },
    }, { hub: 'ws://hub.test/link', state: 'x', version: '2.0.0', mcp: { http: { port: PORT } } }, hub.host());
    await running.ready();
    const url = `http://127.0.0.1:${PORT}/`;
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status).toBe(202);
    expect(await (await fetch(url, { method: 'POST', body: '{nope' })).json()).toMatchObject({ error: { code: -32700 } });
    expect(await (await fetch(url, { method: 'POST', body: JSON.stringify({ hello: 1 }) })).json()).toMatchObject({ error: { code: -32600 } });
  });
});
