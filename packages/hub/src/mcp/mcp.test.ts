/**
 * Hub MCPs end to end in one process: a real registry, scopes, tokens, runner and endpoints over a real store, a
 * catalog of test fns and a fake run service, reached by `@ayepi/mcp`'s own client over Streamable HTTP into the
 * router (no sockets).
 */
import { signJwt } from '@ayepi/auth/server';
import { McpClient, McpHttpClientTransport } from '@ayepi/mcp';
import {
  ActorId, ADMIN_TAG, HubMcpId, McpSlug, mintId, SystemName, type HubMcpInput, type OutcomeWire, type Run, type RunId, type RunSettled,
} from '@harness/core';
import { fn, g } from '@harness/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '../bus/memory.ts';
import type { Catalog } from '../catalog/index.ts';
import type { RunInput } from '../execution/index.ts';
import { ALICE_INFO, OPEN_LIMITS, TestCatalog } from '../execution/testing.ts';
import { memoryLog, settle, testStore } from '../testing.ts';
import { limiter } from '@ayepi/rate';
import { McpRunner } from './calls.ts';
import { HubMcpEndpoints } from './endpoints.ts';
import { StoreMcpRegistry } from './registry.ts';
import { CatalogMcpScopes } from './scopes.ts';
import { HubMcpPrompts, HubMcpResources } from './sources.ts';
import { JwtMcpTokens, MCP_TOKEN_AUDIENCE } from './tokens.ts';
import { HubMcpTools } from './tools.ts';

const ALICE = ActorId.parse(ALICE_INFO.id);
const CLAUDE = SystemName.parse('claude');

/** How a fake run ends: an outcome at once, or held until the test (or a cancel) ends it. */
type Plan = OutcomeWire | 'hold';

/** A run service that records what it was asked and settles runs as the test plans. */
class FakeRuns {
  plan: (input: RunInput) => Plan = (input) => ({ status: 'done', result: { read: input.args } });
  readonly started: RunInput[] = [];
  readonly cancelled: RunId[] = [];
  readonly #rows = new Map<RunId, Run>();
  readonly #held = new Map<RunId, (settled: RunSettled) => void>();

  start(input: RunInput): Promise<{ run: RunId; settled: Promise<RunSettled> }> {
    this.started.push(input);
    const id = mintId('run');
    const base: Run = {
      id, fn: input.fn, fnVersion: 'v1', kind: 'native', system: SystemName.parse(input.fn.split('/')[0] ?? 'fs'), root: id, turn: input.turn, key: input.key,
      actor: input.actor, caller: input.caller, args: input.args, status: 'queued', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0,
      priority: input.priority, background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
    };
    const plan = this.plan(input);
    if (plan === 'hold') {
      this.#rows.set(id, { ...base, status: 'awaiting-approval' });
      return Promise.resolve({ run: id, settled: new Promise<RunSettled>((resolve) => { this.#held.set(id, resolve); }) });
    }
    this.#rows.set(id, { ...base, status: plan.status === 'paused' ? 'paused' : plan.status, outcome: plan });
    return Promise.resolve({ run: id, settled: Promise.resolve({ status: 'done', result: null }) });
  }

  get(id: RunId): Promise<Run | undefined> {
    return Promise.resolve(this.#rows.get(id));
  }

  cancel(id: RunId): Promise<{ accepted: boolean }> {
    this.cancelled.push(id);
    const row = this.#rows.get(id);
    if (row !== undefined) this.#rows.set(id, { ...row, status: 'cancelled', outcome: { status: 'cancelled' } });
    this.#held.get(id)?.({ status: 'cancelled' });
    return Promise.resolve({ accepted: true });
  }
}

/** A catalog of test fns, with no types or context. */
function testCatalog(): TestCatalog & Pick<Catalog, 'entries' | 'typeClosure' | 'type'> {
  const catalog = new TestCatalog();
  catalog.add('fs', 'read', fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
  catalog.add('fs', 'write', fn({ description: 'Write a file.', args: g.obj({ path: g.text(), text: g.text() }), returns: g.bool() }));
  catalog.add('fs', 'bash', fn({ description: 'Run a shell command.', args: g.obj({ command: g.text() }), returns: g.text() }));
  catalog.add('hub', 'create_mcp', fn({ description: 'Make an MCP.', args: g.obj({}), returns: g.obj({}), tags: [ADMIN_TAG] }));
  return Object.assign(catalog, {
    entries: () => Promise.resolve([]),
    typeClosure: (names: readonly string[]) => Promise.resolve({ order: [...names].flatMap((n) => (n.includes('/') ? [] : [])), missing: [] }),
    type: () => Promise.resolve(undefined),
  });
}

const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });

async function hub(settings: { ask?: number; total?: number; rate?: number; idle?: number } = {}) {
  const store = await testStore();
  const bus = new MemoryEventBus(() => undefined);
  const { log, records } = memoryLog();
  const clock = (): number => Date.now();
  await store.table('actors').insert({ id: ALICE, kind: 'user', name: 'Alice', about: '', email: ALICE_INFO.email, role: 'admin', createdAt: 0, disabled: false });
  const catalog = testCatalog();
  const runs = new FakeRuns();
  const registry: StoreMcpRegistry = new StoreMcpRegistry({ store, bus, clock, log, publicUrl: 'https://hub.example', sessions: (mcp): number => endpoints.sessionCount(mcp) });
  const scopes = new CatalogMcpScopes({ catalog: () => catalog, resources: () => ({ roots: () => [], route: () => undefined }), registry: () => registry, bus });
  const tokens = new JwtMcpTokens({ keys: () => store.ports.work.store, registry: () => registry, clock, log, maxTtl: 3_600_000 });
  const runner = new McpRunner({
    store, runs: () => runs, limits: () => ({ resolve: () => Promise.resolve(OPEN_LIMITS) }), clock, log,
    settings: { HARNESS_HUB_MCP_ASK_TIMEOUT: settings.ask ?? 60_000, HARNESS_HUB_MCP_RUN_TIMEOUT: settings.total ?? 120_000 },
    rate: limiter({ limit: settings.rate ?? 100, window: 60_000 }),
  });
  const sources = { scopes: () => scopes, catalog: () => catalog, resources: () => ({ roots: () => [], read: () => Promise.reject(new Error('no resources here')) }), content: () => ({ read: () => Promise.resolve(new Uint8Array()) }) };
  const endpoints: HubMcpEndpoints = new HubMcpEndpoints({
    registry: () => registry, tokens: () => tokens, bus, clock, log, maxBody: 1_048_576, idleTimeout: settings.idle ?? 1_800_000, serverInfo: { name: 'harness', version: 'test' },
    list: async () => (await store.table('mcps').find({ limit: 50 })).items,
    parts: (mcp) => ({
      tools: new HubMcpTools(mcp, { registry: () => registry, scopes: () => scopes, catalog: () => catalog, runner, log }),
      resources: new HubMcpResources(mcp.id, sources),
      prompts: new HubMcpPrompts(mcp.id, sources),
    }),
  });
  stops.push(await endpoints.start());

  /** Make an MCP and wait for it to be mounted. */
  const create = async (input: Partial<HubMcpInput> = {}) => {
    const made = await registry.create({
      slug: McpSlug.parse('claude'), name: 'Claude', instructions: 'Use fs.', toolMode: 'each', user: ALICE, grantees: [CLAUDE], origins: [], enabled: true,
      rules: { include: { systems: [SystemName.parse('fs'), SystemName.parse('hub')] }, exclude: { fns: [{ fn: 'fs/bash' }] } }, ...input,
    }, ALICE);
    await endpoints.settled();
    return made;
  };

  /** A client of an MCP with a bearer token. */
  const connect = async (slug: string, bearer: string) => {
    const transport = new McpHttpClientTransport(`http://hub/mcp/${slug}`, {
      fetch: (input, init) => endpoints.handle(new Request(input, init)), headers: { authorization: `Bearer ${bearer}` },
    });
    const client = await McpClient.connect(transport, { clientInfo: { name: 'claude-code', version: '2.0' } });
    stops.push(() => client.close());
    return client;
  };

  return { store, bus, catalog, runs, registry, scopes, tokens, endpoints, create, connect, records };
}

describe('hub MCPs', () => {
  it('list the exposed fns as tools, never admin-tagged or excluded ones', async () => {
    const h = await hub();
    const { secret } = await h.create();
    const client = await h.connect('claude', secret);
    expect(client.server.instructions).toBe('Use fs.');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['fs_read', 'fs_write']);
    expect(tools[0]).toMatchObject({ title: 'fs/read', description: 'Read a file.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } });
    expect(tools[1]?.annotations?.readOnlyHint).toBe(false);
  });

  it('run a call as a real run for the MCP’s person, attributed to its actor, and answer with the result', async () => {
    const h = await hub();
    const { mcp, secret } = await h.create();
    const client = await h.connect('claude', secret);
    const result = await client.callTool('fs_read', { path: 'README.md' });
    expect(result).toMatchObject({ structuredContent: { read: { path: 'README.md' } } });
    expect(result.isError).not.toBe(true);
    expect(h.runs.started).toMatchObject([{ fn: 'fs/read', args: { path: 'README.md' }, actor: ALICE, caller: mcp.actor, priority: 'interactive' }]);
    const turn = await h.store.table('turns').get(h.runs.started[0]?.turn ?? mintId('turn'));
    expect(turn).toMatchObject({ actor: ALICE, status: 'done' });
    expect(turn?.root).toBeDefined();
    const sessions = await h.endpoints.sessions(mcp.id);
    expect(sessions).toMatchObject([{ label: 'secret', client: { name: 'claude-code', version: '2.0' }, calls: 1 }]);
    expect((await h.registry.get(mcp.id))).toMatchObject({ url: 'https://hub.example/mcp/claude', sessions: 1 });
  });

  it('answer refused input and failures as errors the model reads', async () => {
    const h = await hub();
    const { secret } = await h.create();
    const client = await h.connect('claude', secret);
    h.runs.plan = () => ({ status: 'invalid-input', invalid: { source: 'schema', problems: [{ path: 'path', message: 'Expected string' }] } });
    const refused = await client.callTool('fs_read', { path: 3 });
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: 'The input for fs/read was refused; fix it and call again:\n- path: Expected string' }] });
    h.runs.plan = () => ({ status: 'failed', error: { class: 'fatal', message: 'disk on fire' } });
    expect(await client.callTool('fs_write', { path: 'a', text: 'b' })).toMatchObject({ isError: true, content: [{ text: 'disk on fire' }] });
  });

  it('keep a call open while it waits for approval, and end it when approval takes too long', async () => {
    const h = await hub({ ask: 30 });
    const { secret } = await h.create();
    const client = await h.connect('claude', secret);
    h.runs.plan = () => 'hold';
    expect(await client.callTool('fs_write', { path: 'a', text: 'b' })).toMatchObject({ isError: true, content: [{ text: 'The call was not approved in time.' }] });
    expect(h.runs.cancelled).toHaveLength(1);
  });

  it('cancel the run when the client cancels the call', async () => {
    const h = await hub();
    const { secret } = await h.create();
    const client = await h.connect('claude', secret);
    h.runs.plan = () => 'hold';
    const stop = new AbortController();
    const call = client.callTool('fs_write', { path: 'a', text: 'b' }, { signal: stop.signal });
    await settle(20);
    stop.abort();
    // the client hears the cancel at once (or the answer saying so); either way the run is cancelled
    await call.catch(() => undefined);
    await settle(20);
    expect(h.runs.cancelled).toHaveLength(1);
  });

  it('end open sessions when the rules change, tell clients when the catalog changes the list, and refuse a tool hidden since', async () => {
    const h = await hub();
    const { mcp, secret } = await h.create();
    const client = await h.connect('claude', secret);
    expect((await client.listTools()).map((t) => t.name)).toEqual(['fs_read', 'fs_write']);
    await h.registry.update(mcp.id, { rules: { include: { systems: [SystemName.parse('fs')] }, exclude: { fns: [{ fn: 'fs/bash' }, { fn: 'fs/write' }] } } }, ALICE);
    await h.endpoints.settled();
    // a change to an MCP remounts it, which ends its sessions: the open client's next call is refused, so it reconnects
    await expect(client.listTools()).rejects.toThrow('unknown or ended session');
    await expect(client.callTool('fs_write', { path: 'a', text: 'b' })).rejects.toThrow('unknown or ended session');
    expect(h.runs.started).toEqual([]);
    const again = await h.connect('claude', secret);
    expect((await again.listTools()).map((t) => t.name)).toEqual(['fs_read']);
    expect(await again.callTool('fs_write', { path: 'a', text: 'b' }).catch((error: unknown) => (error instanceof Error ? error.message : ''))).toMatch(/unknown tool/);
    // a catalog change refreshes the list on the open session
    const next = again.nextNotification('notifications/tools/list_changed');
    h.catalog.add('fs', 'stat', fn({ description: 'Stat a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] }));
    h.bus.publish('catalog.changed', { added: ['fs/stat'], removed: [], fns: [] });
    await h.endpoints.settled();
    await next;
    expect((await again.listTools()).map((t) => t.name)).toEqual(['fs_read', 'fs_stat']);
  });

  it('refuse a missing or wrong bearer, an old secret after rotating, and a switched-off MCP', async () => {
    const h = await hub();
    const { mcp, secret } = await h.create();
    await expect(h.connect('claude', 'hmcp_wrong')).rejects.toThrow();
    const raw = await h.endpoints.handle(new Request('http://hub/mcp/claude', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    expect(raw.status).toBe(401);
    expect(raw.headers.get('www-authenticate')).toContain('Bearer');
    const { secret: fresh } = await h.registry.rotate(mcp.id, ALICE);
    await h.endpoints.settled();
    await expect(h.connect('claude', secret)).rejects.toThrow();
    await expect((await h.connect('claude', fresh)).listTools()).resolves.toHaveLength(2);
    await h.registry.update(mcp.id, { enabled: false }, ALICE);
    await h.endpoints.settled();
    expect((await h.endpoints.handle(new Request('http://hub/mcp/claude', { method: 'POST', body: '{}' }))).status).toBe(404);
    expect((await h.endpoints.handle(new Request('http://hub/mcp/nobody', { method: 'POST', body: '{}' }))).status).toBe(404);
  });

  it('let grantee systems mint labelled session tokens, refusing others and expired tokens', async () => {
    const h = await hub();
    const { mcp } = await h.create();
    await expect(h.tokens.mint({ mcp: mcp.id, label: 'session 1', ttl: 60_000, system: SystemName.parse('web') })).rejects.toMatchObject({ status: 403 });
    const { token, expiresAt } = await h.tokens.mint({ mcp: mcp.id, label: 'session 1', ttl: 60_000, system: CLAUDE });
    expect(expiresAt).toBeGreaterThan(Date.now());
    const client = await h.connect('claude', token);
    await client.callTool('fs_read', { path: 'a' });
    expect(await h.endpoints.sessions(mcp.id)).toMatchObject([{ label: 'token:session 1' }]);
    const secret = await h.store.ports.work.store.get('mcp:token-secret');
    const expired = signJwt({ mcp: mcp.id, label: 'old' }, { secret: secret ?? '', expiresIn: -60, audience: MCP_TOKEN_AUDIENCE }).token;
    await expect(h.connect('claude', expired)).rejects.toThrow();
    await expect(h.tokens.verify(expired)).resolves.toBeUndefined();
    const other = signJwt({ mcp: HubMcpId.parse('mcp_other'), label: 'x', exp: 0 }, { secret: secret ?? '', expiresIn: 60, audience: MCP_TOKEN_AUDIENCE }).token;
    await expect(h.connect('claude', other)).rejects.toThrow();
  });

  it('drop a session when its client closes it, or goes quiet past the idle timeout', async () => {
    const h = await hub({ idle: 40 });
    const { mcp, secret } = await h.create();
    const closing = await h.connect('claude', secret);
    expect(h.endpoints.sessionCount(mcp.id)).toBe(1);
    await closing.close();
    expect(h.endpoints.sessionCount(mcp.id)).toBe(0);

    // a client with no event stream that never says goodbye (killed, crashed)
    const quiet = await McpClient.connect(new McpHttpClientTransport('http://hub/mcp/claude', {
      fetch: (input, init) => h.endpoints.handle(new Request(input, init)), headers: { authorization: `Bearer ${secret}` }, events: false,
    }), { clientInfo: { name: 'gone', version: '1' } });
    await quiet.callTool('fs_read', { path: 'a' });
    expect(await h.endpoints.sessions(mcp.id)).toMatchObject([{ client: { name: 'gone' }, calls: 1 }]);
    await expect.poll(() => h.endpoints.sessionCount(mcp.id)).toBe(0);
    expect(h.records).toContainEqual(expect.objectContaining({ msg: 'mcp.session.ended', mcp: mcp.id, reason: 'idle' }));
    await expect(quiet.ping()).rejects.toThrow('unknown or ended session');
  });

  it('serve the static toolset: find and inspect as runs of the hub fns, run over the exposed fns', async () => {
    const h = await hub();
    const { mcp, secret } = await h.create({ toolMode: 'static', slug: McpSlug.parse('small') });
    const client = await h.connect('small', secret);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['find', 'inspect', 'run']);
    // the args are the hub fns' own and the chat's `run` args, so a fleet's `on` is there too
    expect(tools[0]?.inputSchema).toMatchObject({ properties: { query: {}, kinds: {}, limit: {} } });
    expect(tools[1]?.inputSchema).toMatchObject({ properties: { name: {}, detail: {} } });
    expect(tools[2]?.inputSchema).toMatchObject({ properties: { fn: {}, args: {}, on: {} } });
    expect(await client.callTool('find', { query: 'write a file' })).toMatchObject({ structuredContent: { read: { query: 'write a file' } } });
    expect(await client.callTool('inspect', { name: 'fs/read' })).toMatchObject({ structuredContent: { read: { name: 'fs/read' } } });
    expect(await client.callTool('run', { fn: 'fs/read', args: { path: 'x' }, on: 'laptop' })).toMatchObject({ structuredContent: { read: { path: 'x' } } });
    expect(await client.callTool('run', { fn: 'fs/bash', args: { command: 'rm -rf /' } })).toMatchObject({ isError: true, content: [{ text: 'fs/bash is not available through this MCP.' }] });
    expect(await client.callTool('run', { fn: 'hub/create_mcp', args: {} })).toMatchObject({ isError: true });
    expect(h.runs.started).toMatchObject([
      { fn: 'hub/find', args: { query: 'write a file' }, caller: mcp.actor },
      { fn: 'hub/inspect', args: { name: 'fs/read' }, caller: mcp.actor },
      { fn: 'fs/read', args: { path: 'x' }, on: 'laptop', caller: mcp.actor },
    ]);
  });

  it('limit how many calls an MCP may start a minute', async () => {
    const h = await hub({ rate: 1 });
    const { secret } = await h.create();
    const client = await h.connect('claude', secret);
    await client.callTool('fs_read', { path: 'a' });
    const limited = await client.callTool('fs_read', { path: 'b' });
    expect(limited.isError).toBe(true);
    expect(limited.content[0]?.type === 'text' ? limited.content[0].text : '').toContain('Too many calls');
    expect(h.runs.started).toHaveLength(1);
  });

  it('keep routes unique and only for active people', async () => {
    const h = await hub();
    await h.create();
    await expect(h.create()).rejects.toMatchObject({ status: 409 });
    await expect(h.create({ slug: McpSlug.parse('other'), user: ActorId.parse('act_nobody') })).rejects.toMatchObject({ status: 422 });
  });
});
