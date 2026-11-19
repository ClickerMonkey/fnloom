/**
 * The MCP system over the SDK's link runtime and the test kit's fake hub, against a small local MCP server built with
 * `@ayepi/mcp` and reached in memory: tools, prompts and resources mirrored (only what changed, never removing),
 * mirrored again when the server says a list changed, tool calls (structured, plain, failed), what trust and the
 * approval policy make of a tool, reconnecting after the server goes away, per-person tokens through the connect form,
 * and a question the server asks during a call answered on an approval card.
 */
import { readFileSync } from 'node:fs';
import {
  McpMemoryClientTransport, McpToolSet, errorResult, jsonResult, mcpSourceServer, textResult,
  type JsonRpcNotification, type JsonRpcOutgoingRequest, type JsonRpcResponse, type McpClientTransport, type McpPromptSource,
  type McpResourceSource, type McpServer,
} from '@ayepi/mcp';
import { ActorId, MCP_TOOL_KIND, McpToolSpec, SystemPackageManifest, type FnDecl, type Json, mintId, type ContextDecl, type OutcomeWire, type RunConnection } from '@harness/core';
import { sampleArgs } from '@harness/sdk';
import { testHub, TEST_USER, type TestSystem } from '@harness/sdk/testing';
import type { RunningSystem, SystemPatch } from '@harness/sdk/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ElicitationReply, mcp, type McpContract } from '../shared/index.ts';
import type { DialerFactory, OpenedTransport, Signer } from './dial.ts';
import { mcpEnv } from './env.ts';
import { createMcpImpl, type McpServer as McpSystem } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));
const SETTINGS = { ...mcpEnv.parse(), MCP_RECONNECT_MIN: 20, MCP_RECONNECT_MAX: 40, MCP_MIRROR_SETTLE: 5, MCP_PING_EVERY: 0 };
const NOW = Date.parse('2026-11-13T12:00:00Z');

/** The question the fixture's `choose` tool asks. */
const ASK = { message: 'Which project?', requestedSchema: { type: 'object', properties: { project: { type: 'string', description: 'The project' } }, required: ['project'] } };

/** A small MCP server: tools (one structured, one plain, one with a schema gin can't read, one failing), a prompt, a resource. */
function fixture() {
  const tools = new McpToolSet()
    .define({
      name: 'add', description: 'Add two numbers.', annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
      run: (args) => jsonResult({ sum: Number(args['a']) + Number(args['b']) }),
    })
    .define({
      name: 'echo-text', description: 'Say something back.', args: z.object({ text: z.string().describe('What to say') }),
      run: ({ text }, { caller }) => textResult(`${text} (as ${caller.auth?.subject ?? 'anyone'})`),
    })
    .define({ name: 'odd', description: 'A schema with a missing $ref.', inputSchema: { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } }, validate: false, run: () => textResult('odd') })
    .define({ name: 'boom', description: 'Always fails.', inputSchema: { type: 'object' }, run: () => errorResult('it broke') })
    .define({ name: 'choose', description: 'Asks which project.', inputSchema: { type: 'object' }, run: () => textResult('never reached: the transport answers') });
  const prompts: McpPromptSource = {
    prompts: () => [{ name: 'summarize', title: 'Summarize', description: 'Summarize a topic.', arguments: [{ name: 'topic', description: 'What to summarize', required: true }] }],
    get: (name, args) => Promise.resolve(name === 'summarize' ? { messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${args['topic'] ?? ''} in three lines.` } }] } : undefined),
  };
  const resources: McpResourceSource = {
    list: () => Promise.resolve({ resources: [{ uri: 'mem://notes/today.md', name: 'today.md', mimeType: 'text/markdown' }] }),
    read: (uri) => Promise.resolve(uri === 'mem://notes/today.md' ? [{ uri, mimeType: 'text/markdown', text: '# Today\nShip it.' }] : undefined),
  };
  return { tools, server: mcpSourceServer({ tools, prompts, resources }, { serverInfo: { name: 'fixture', version: '1.0.0' }, instructions: 'Use add for sums.' }) };
}

/**
 * The memory transport, plus the one thing `@ayepi/mcp`'s server doesn't do: ask the client during a call. A call of
 * `choose` sends the client an `elicitation/create` first and answers with what came back.
 */
class AskingTransport implements McpClientTransport {
  readonly #inner: McpMemoryClientTransport;
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #answers = new Map<string, (response: JsonRpcResponse) => void>();

  constructor(inner: McpMemoryClientTransport) {
    this.#inner = inner;
  }

  async request(message: JsonRpcOutgoingRequest, signal: AbortSignal): Promise<unknown> {
    const call = z.object({ name: z.literal('choose') }).safeParse(message.params);
    if (message.method !== 'tools/call' || !call.success) { return this.#inner.request(message, signal); }
    const id = `ask-${String(message.id)}`;
    const answered = new Promise<JsonRpcResponse>((resolve) => { this.#answers.set(id, resolve); });
    for (const listener of this.#listeners) { listener({ jsonrpc: '2.0', id, method: 'elicitation/create', params: ASK }); }
    const response = await answered;
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify('result' in response ? response.result : response.error) }] } };
  }

  notify(message: JsonRpcNotification): Promise<void> { return this.#inner.notify(message); }

  respond(message: JsonRpcResponse): Promise<void> {
    if (typeof message.id === 'string') { this.#answers.get(message.id)?.(message); }
    return Promise.resolve();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    const stop = this.#inner.onMessage(listener);
    return () => { this.#listeners.delete(listener); stop(); };
  }

  opened(): void { this.#inner.opened(); }
  listen(): void { this.#inner.listen(); }
  close(): Promise<void> { return this.#inner.close(); }
}

/** Dials the fixture in memory: a bearer token becomes the caller the server sees; `fail` refuses that many dials. */
class MemoryDialers implements DialerFactory {
  readonly server: McpServer;
  readonly endings: Array<(why: string) => void> = [];
  fail = 0;
  opened = 0;

  constructor(server: McpServer) {
    this.server = server;
  }

  dialer(_transport: unknown, signer: Signer) {
    return {
      open: async (): Promise<OpenedTransport> => {
        this.opened += 1;
        if (this.fail > 0) {
          this.fail -= 1;
          throw new Error('connection refused');
        }
        const token = (await signer.headers())['authorization']?.replace(/^Bearer /, '');
        const transport = new AskingTransport(new McpMemoryClientTransport(this.server, token === undefined ? {} : { auth: { subject: token, scopes: [] } }));
        const ended = new Promise<string>((resolve) => { this.endings.push(resolve); });
        return { transport, ended, close: () => transport.close() };
      },
    };
  }
}

const CONFIG = { label: 'Fixture', transport: { type: 'http', url: 'http://fixture.test/mcp' } };

/** Wait until `check` holds (the mirror and reconnects happen in the background). */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) { return; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

describe('the mcp system', () => {
  let kit: TestSystem<'mcp', McpContract['defs']> | undefined;
  let system: McpSystem | undefined;

  afterEach(async () => {
    await kit?.stop();
    await system?.close();
    kit = undefined;
    system = undefined;
  });

  /** Serve the system to a fake hub over the fixture, configured with `config`. */
  async function start(dialers: MemoryDialers, config: unknown = CONFIG): Promise<TestSystem<'mcp', McpContract['defs']>> {
    let resolveRunning: (running: RunningSystem<'mcp'>) => void = () => undefined;
    const running = new Promise<RunningSystem<'mcp'>>((resolve) => { resolveRunning = resolve; });
    system = createMcpImpl({
      settings: SETTINGS, dialers, version: '0.1.0', now: () => NOW, fetch: () => Promise.reject(new Error('no network in tests')),
      patch: async (change: SystemPatch) => (await running).patch(change),
    });
    kit = await testHub(mcp, system.impl, { config });
    resolveRunning(kit.running);
    return kit;
  }

  const fnsSent = (test: TestSystem<'mcp', McpContract['defs']>): FnDecl[] => test.hub.patches.flatMap((patch) => patch.upsert.fns ?? []);
  const contextSent = (test: TestSystem<'mcp', McpContract['defs']>): ContextDecl[] => test.hub.patches.flatMap((patch) => patch.upsert.context ?? []);
  const toolFn = (test: TestSystem<'mcp', McpContract['defs']>, name: string): FnDecl => {
    const found = fnsSent(test).findLast((decl) => decl.name === name);
    if (found === undefined) { throw new Error(`no fn ${name} was mirrored`); }
    return found;
  };
  /** Run a mirrored tool fn as the hub does: its kind and payload with the call. */
  const runTool = (test: TestSystem<'mcp', McpContract['defs']>, name: string, args: Json, extra: { connection?: RunConnection } = {}) => {
    const decl = toolFn(test, name);
    return test.hub.run(`mcp/${name}`, args, { kind: MCP_TOOL_KIND, ...(decl.payload === undefined ? {} : { payload: decl.payload }), ...extra });
  };

  it('is a fleet system that may start a server process', () => {
    expect(packageManifest.instances).toBe('many');
    expect(packageManifest.permissions?.childProcess).toBe(true);
  });

  it('mirrors tools, prompts and resources, calls tools and reports its status', async () => {
    const test = await start(new MemoryDialers(fixture().server));
    await until(() => fnsSent(test).length > 0, 'the mirror');
    expect(test.hub.instanceConnect).toEqual({ share: false, title: 'Fixture' });

    expect(fnsSent(test).map((decl) => decl.name).sort()).toEqual(['main_add', 'main_boom', 'main_choose', 'main_echo_text', 'main_odd']);
    const add = toolFn(test, 'main_add');
    expect(add.kind).toBe(MCP_TOOL_KIND);
    expect(add.routing).toEqual({ to: 'instance', instance: 'main' });
    expect(add.description).toBe('Fixture: Add two numbers.');

    const [summarize] = contextSent(test);
    expect(summarize?.command).toEqual({ name: 'main_summarize', args: [{ name: 'topic', hint: 'What to summarize', required: true }] });
    // the prompt's text is fetched with placeholders, so the hub fills them when the command is used
    expect(summarize?.content).toBe('**user:** Summarize {{topic}} in three lines.');

    const status = (await test.call('server_status', {})).result;
    expect(status).toMatchObject({ state: 'connected', tools: 5, prompts: 1, resources: 1, degraded: ['odd'], leftOut: 0, server: { name: 'fixture', instructions: 'Use add for sums.' } });

    // a declared output schema makes the structured content the result; otherwise text
    expect(done(await runTool(test, 'main_add', { a: 2, b: 3 }))).toEqual({ sum: 5 });
    expect(done(await runTool(test, 'main_echo_text', { text: 'hi' }))).toEqual({ text: 'hi (as anyone)' });
    const failed = await runTool(test, 'main_boom', {});
    expect(failed).toMatchObject({ status: 'failed', error: { class: 'caller', message: 'it broke' } });

    // the kind: an untrusted server's tools all write and ask; its hints are not believed
    const described = await test.kindProps('tool', McpToolSpec.parse(add.payload));
    expect(described.description?.effects).toEqual({ mode: 'write' });
    expect(described.description?.approval).toEqual({ preview: true, remember: false, approver: 'person' });
    // with no examples in its schema, its args filled with sample values read off it
    const note: unknown = expect.stringContaining('Sample args read off the add tool');
    expect(described.description?.examples).toEqual([{ args: sampleArgs(McpToolSpec.parse(add.payload).args), note }]);

    // resources: the instance's root, its listing and a read through the server
    const provider = system?.impl.resources;
    expect((await provider?.roots())?.map((root) => root.uri)).toEqual(['mcp://main/']);
    const listed = await provider?.list('mcp://main/');
    expect(listed?.items.map((item) => item.uri)).toEqual([`mcp://main/${encodeURIComponent('mem://notes/today.md')}`]);
    const read = await provider?.read(`mcp://main/${encodeURIComponent('mem://notes/today.md')}`, ['text']);
    expect(read?.text).toEqual({ inline: '# Today\nShip it.' });
  });

  it('believes a trusted server\'s hints, and mirrors again only what changed when the server says so', async () => {
    const { tools, server } = fixture();
    const test = await start(new MemoryDialers(server), { ...CONFIG, trusted: true, maxTools: 4 });
    await until(() => fnsSent(test).length > 0, 'the mirror');
    expect((await test.call('server_status', {})).result).toMatchObject({ tools: 4, leftOut: 1 });

    const add = toolFn(test, 'main_add');
    const described = await test.kindProps('tool', McpToolSpec.parse(add.payload));
    expect(described.description?.effects).toEqual({ mode: 'read' });
    expect(described.description?.approval).toBeUndefined();

    const before = test.hub.patches.length;
    tools.remove('odd');
    tools.define({ name: 'again', description: 'New.', inputSchema: { type: 'object' }, run: () => textResult('again') });
    await until(() => test.hub.patches.length > before, 'the second mirror');
    // only the new tool goes; the removed one stays in the hub (a server's absence never deletes)
    expect(test.hub.patches.slice(before).flatMap((patch) => patch.upsert.fns ?? []).map((decl) => decl.name)).toEqual(['main_again']);
    expect(test.hub.patches.every((patch) => (patch.remove.fns ?? []).length === 0)).toBe(true);
  });

  it('reconnects with backoff after the server goes away', async () => {
    const dialers = new MemoryDialers(fixture().server);
    dialers.fail = 1;
    const test = await start(dialers);
    await until(() => fnsSent(test).length > 0, 'the mirror after a failed first dial');
    expect(dialers.opened).toBe(2);

    dialers.fail = 1;
    dialers.endings.at(-1)?.('the server process exited (code 1)');
    await until(() => system?.instance()?.status().state === 'unreachable', 'the link down');
    expect(system?.instance()?.status().problem).toContain('exited');
    await until(() => system?.instance()?.status().state === 'connected', 'the link back');
    expect(dialers.opened).toBe(4);
    expect(done(await runTool(test, 'main_add', { a: 1, b: 1 }))).toEqual({ sum: 2 });
  });

  it('connects each person with their own token, and calls as them', async () => {
    const test = await start(new MemoryDialers(fixture().server), { ...CONFIG, auth: { kind: 'bearer', per: 'person' } });
    expect(test.hub.instanceConnect?.flow?.flow).toBe('form');
    expect((await test.call('server_status', {})).result.state).toBe('needs-auth');

    const id = mintId('connection');
    const result = await test.hub.connectFinish({ connection: id, owner: TEST_USER.id, redirect: 'https://hub.test/connect/callback', answer: { form: { token: 'tok-ada-1234' } } });
    if (!('credentials' in result)) { throw new Error(result.problem); }
    expect(result.account).toEqual({ label: 'Token ending 1234', detail: 'Fixture' });
    // the first person to connect lets the instance mirror the server
    await until(() => fnsSent(test).length > 0, 'the mirror');

    const connection: RunConnection = { id, owner: TEST_USER.id, credentials: result.credentials, settings: {} };
    expect(done(await runTool(test, 'main_echo_text', { text: 'hi' }, { connection }))).toEqual({ text: 'hi (as tok-ada-1234)' });
    expect(await runTool(test, 'main_echo_text', { text: 'hi' })).toMatchObject({ status: 'failed', error: { class: 'caller' } });
    expect((await test.hub.connectFinish({ connection: id, owner: TEST_USER.id, redirect: 'https://hub.test/connect/callback', answer: { form: {} } }))).toEqual({ problem: 'Give your token.' });
  });

  it('asks the call\'s person what the server asks, on an approval card, and declines when they do', async () => {
    const test = await start(new MemoryDialers(fixture().server));
    await until(() => fnsSent(test).length > 0, 'the mirror');

    const call = runTool(test, 'main_choose', {});
    await until(() => test.hub.proposals.length === 1, 'the question');
    const [proposal] = test.hub.proposals;
    expect(proposal?.fn).toBe('answer_elicitation');
    expect(proposal?.preview.title).toBe('Fixture asks: Which project?');
    expect(proposal?.ask?.into).toBe('content');
    await test.hub.approveProposal(proposal?.key ?? '', { answer: { project: 'Website' } });
    expect(done(await call)).toEqual({ text: JSON.stringify({ action: 'accept', content: { project: 'Website' } }) });

    const again = runTool(test, 'main_choose', {});
    await until(() => test.hub.proposals.length === 2, 'the second question');
    // only the approved proposal answers: a direct call naming the waiting question is refused
    const waiting = ElicitationReply.parse(test.hub.proposals[1]?.args);
    expect((await test.call('answer_elicitation', { request: waiting.request, content: { project: 'Forged' } })).result).toEqual({ sent: false });
    await test.hub.declineProposal(test.hub.proposals[1]?.key ?? '', 'not now');
    expect(done(await again)).toEqual({ text: JSON.stringify({ action: 'decline' }) });
  });

  it('declines a server question when calls of two people share the link, never asking one about the other\'s call', async () => {
    const test = await start(new MemoryDialers(fixture().server));
    await until(() => fnsSent(test).length > 0, 'the mirror');
    const first = runTool(test, 'main_choose', {});
    await until(() => test.hub.proposals.length === 1, 'the first person\'s question');
    const decl = toolFn(test, 'main_choose');
    const other = { ...TEST_USER, id: ActorId.parse('act_bea'), name: 'Bea' };
    const second = test.hub.run('mcp/main_choose', {}, { kind: MCP_TOOL_KIND, ...(decl.payload === undefined ? {} : { payload: decl.payload }), run: test.hub.runInfo('mcp/main_choose', { user: other }) });
    expect(done(await second)).toEqual({ text: JSON.stringify({ action: 'decline' }) });
    expect(test.hub.proposals).toHaveLength(1);
    await test.hub.approveProposal(test.hub.proposals[0]?.key ?? '', { answer: { project: 'Website' } });
    expect(done(await first)).toEqual({ text: JSON.stringify({ action: 'accept', content: { project: 'Website' } }) });
  });
});
