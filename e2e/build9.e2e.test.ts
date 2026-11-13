/**
 * Build 9 end to end, over the web API with the stack's chat model:
 * - an MCP server added from the web app (`addInstance`) becomes an `mcp` instance whose tools run with approvals:
 *   a local server over stdio (its tool called from chat), and one over HTTP behind a bearer token (called by hand);
 * - a code fn is written by `code/make_code` and runs;
 * - an API service added the same way gets an api fn written by `api/make_api` against a local JSON service, which runs;
 * - with `HARNESS_E2E_CLAUDE` (it starts one real Claude Code session, on Haiku), the claude system starts a session in
 *   a scratch folder, its tool permission shows as an approval card in the chat, and the answer goes back to Claude.
 * The local services listen on `HARNESS_E2E_SERVICE_PORT` and the one after it.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { BearerAuth, McpToolSet, mcpHttp, mcpToolServer, textResult, type McpHttpHandler } from '@ayepi/mcp';
import {
  CLAUDE_SESSION_TYPE, ClaudeSession, ClaudeTurn, InstanceName, QualifiedName, SystemName, isSettled, qualify, type Json, type Run, type SessionId,
} from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { ROOT } from '../scripts/stack.ts';
import { admin, Approver, ask, clientInfo, SessionWatch, settings, settle, settled, textOf } from './kit.ts';
import { approvePending, goLive } from './review.ts';

const TOKEN = 'e2e-bearer-token-4f2a';
/** What an authoring fn (`make_code`, `make_api`) answers: the fn it saved. */
const Authored = z.object({ fn: z.string() });
const MCP_PORT = settings.HARNESS_E2E_SERVICE_PORT;
const API_PORT = settings.HARNESS_E2E_SERVICE_PORT + 1;
const MCP = SystemName.parse('mcp');
const API = SystemName.parse('api');
/** Adding an instance installs, starts and pairs a process, then mirrors the server. */
const START = 180_000;
const TURN = settings.HARNESS_E2E_TURN_TIMEOUT;

let me: SignedIn;
let session: SessionId;
let watch: SessionWatch;
let approver: Approver;
const servers: Server[] = [];
let mcpHandler: McpHttpHandler | undefined;

/** Serve a fetch handler over node's HTTP server, streaming the response body. */
function serveFetch(port: number, handle: (request: Request) => Promise<Response>): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) { if (Buffer.isBuffer(chunk)) { chunks.push(chunk); } }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) { if (typeof value === 'string') { headers.set(name, value); } }
      const body = req.method === 'GET' || req.method === 'HEAD' || chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const response = await handle(new Request(`http://127.0.0.1:${String(port)}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) }));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body === null) { res.end(); return; }
      const reader = response.body.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) { res.write(read.value); }
      res.end();
    })().catch((error: unknown) => { res.writeHead(500); res.end(String(error)); });
  });
  servers.push(server);
  return new Promise((done) => { server.listen(port, '0.0.0.0', done); });
}

/** The todo service the api test writes a request for: one GET, described by an OpenAPI document. */
async function todoService(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/openapi.json') {
    return Response.json({
      openapi: '3.0.0', info: { title: 'Todos', version: '1' },
      paths: { '/todos/{id}': { get: { operationId: 'getTodo', summary: 'One todo by its id: { id, title, done }', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] } } },
    });
  }
  const todo = /^\/todos\/(\d+)$/.exec(path);
  if (todo !== null && request.method === 'GET') { return Response.json({ id: Number(todo[1]), title: `Todo number ${todo[1] ?? ''}`, done: false }); }
  return new Response('not found', { status: 404 });
}

/** Add an instance from the web app, as its admin page does, and go live with what it brings. */
async function addInstance(system: SystemName, instance: string, config: Json): Promise<void> {
  await me.hub.call('addInstance', { system, instance: InstanceName.parse(instance), config });
  const live = await waitFor(`${system}@${instance} to connect`, async () => {
    const found = (await me.hub.call('instances', { system })).find((one) => one.instance === instance);
    return found?.status === 'connected' ? found : undefined;
  }, { timeout: START, every: 500 });
  expect(live.status).toBe('connected');
  const view = (await me.hub.call('systems', {})).find((one) => one.name === system);
  if (view?.stage === 'installed') { await goLive(me, system); }
}

/** A fn of a system once it is listed, usable and live: what the instance mirrored waits as a pending review until approved. */
async function usable(system: SystemName, fn: string): Promise<void> {
  await waitFor(`${fn} to be usable`, async () => {
    const review = await me.hub.call('systemReview', { system });
    if (review.pending !== undefined) { await approvePending(me, system); return undefined; }
    const found = (await me.hub.call('systemFns', { system })).find((one) => one.name === fn);
    return found?.available === true ? true : undefined;
  }, { timeout: START, every: 1_000 });
}

/** Run a fn by hand in the session (on an instance when given), saying yes to its approvals, and wait for it. */
async function invoked(fn: string, args: Json, on?: string): Promise<{ run: Run; approvals: number }> {
  const { result, approvals } = await approver.during((async () => {
    const { run } = await me.hub.call('invoke', { session, fn: QualifiedName.parse(fn), args, ...(on === undefined ? {} : { on: InstanceName.parse(on) }), client: clientInfo() });
    return settled(me, run, TURN);
  })());
  return { run: result, approvals: approvals.length };
}

/** A done run's result. */
function resultOf(run: Run): Json {
  if (run.outcome?.status !== 'done') { throw new Error(`${run.fn} ended ${run.status}: ${JSON.stringify(run.outcome ?? run.errors)}`); }
  return run.outcome.result;
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e build 9' })).id;
  watch = new SessionWatch(me, session);
  approver = new Approver(me, watch);
  const tools = new McpToolSet().define({ name: 'secret_word', inputSchema: { type: 'object' }, run: () => textResult('The secret word is plum.') });
  mcpHandler = mcpHttp(mcpToolServer(tools), { authorize: new BearerAuth([{ secret: TOKEN, subject: 'e2e' }]) });
  const handler = mcpHandler;
  await serveFetch(MCP_PORT, (request) => handler.fetch(request));
  await serveFetch(API_PORT, todoService);
}, START);

afterAll(async () => {
  watch.stop();
  mcpHandler?.close();
  for (const server of servers) { await new Promise((done) => { server.close(done); }); }
  me.close();
});

describe('MCP servers added from the web app', () => {
  it('runs a stdio server\'s tool from chat, after an approval', async () => {
    await addInstance(MCP, 'greeter', {
      label: 'Greeter', transport: { type: 'stdio', command: process.execPath, args: [join(ROOT, 'systems', 'mcp', 'server', 'fixtures', 'stdio-server.ts')], env: { GREETER: 'the e2e test' } }, auth: { kind: 'none' },
    });
    await usable(MCP, 'mcp/greeter_hello');
    const { result, approvals } = await approver.during(ask(me, watch, 'Call the mcp/greeter_hello tool once and tell me exactly what it said.', TURN));
    expect(approvals.map((approval) => approval.fn)).toContain('mcp/greeter_hello');
    expect(textOf(result.answer)).toContain('the e2e test');
  }, START + TURN);

  it('runs an HTTP server\'s tool behind a bearer token', async () => {
    await addInstance(MCP, 'words', { label: 'Words', transport: { type: 'http', url: `http://127.0.0.1:${String(MCP_PORT)}/` }, auth: { kind: 'bearer', per: 'shared', token: TOKEN } });
    await usable(MCP, 'mcp/words_secret_word');
    const { run, approvals } = await invoked('mcp/words_secret_word', {});
    expect(approvals).toBe(1);
    expect(JSON.stringify(resultOf(run))).toContain('plum');
    // the token is a sealed secret: the instance's config never shows it again
    expect(JSON.stringify(await me.hub.call('instances', { system: MCP }))).not.toContain(TOKEN);
  }, START + TURN);
});

describe('code and api fns', () => {
  it('writes a code fn and runs it', async () => {
    const made = resultOf((await invoked('code/make_code', { request: 'Add two numbers: args a (num) and b (num); returns their sum (num). 2 and 3 give 5.' })).run);
    const { fn } = Authored.parse(made);
    expect(fn).toMatch(/^code\//);
    expect(resultOf((await invoked(fn, { a: 2, b: 40 })).run)).toBe(42);
  }, 3 * TURN);

  it('writes an api fn for a service added from the web app and runs it', async () => {
    const base = `http://127.0.0.1:${String(API_PORT)}`;
    await addInstance(API, 'todos', { label: 'Todos', baseUrl: base, openapi: `${base}/openapi.json`, auth: { kind: 'none' } });
    await usable(API, 'api/make_api');
    const made = resultOf((await invoked('api/make_api', { request: 'One todo by its id: GET /todos/{id}; arg id (num); give its title (text). Todo 7 gives "Todo number 7".' }, 'todos')).run);
    const { fn } = Authored.parse(made);
    expect(fn).toMatch(/^api\//);
    expect(JSON.stringify(resultOf((await invoked(fn, { id: 12 }, 'todos')).run))).toContain('Todo number 12');
  }, 3 * TURN + START);
});

describe.runIf(settings.HARNESS_E2E_CLAUDE)('the claude system', () => {
  it('starts a session in a scratch folder; its permission is a card in the chat and the answer goes back', async () => {
    const folder = resolve(ROOT, settings.HARNESS_E2E_DATA, 'claude-scratch');
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const start = await invoked('claude/start_session', {
      folder, prompt: 'Use the Write tool to create the file note.txt in the current folder containing exactly: harness-ok. Then reply with only: harness-ok', model: 'haiku', permissionMode: 'default', wait: false,
    });
    const turn = ClaudeTurn.parse(resultOf(start.run));
    // the session is the person's record, listed from the hub's database
    const listed = await me.hub.call('records', { type: QualifiedName.parse(CLAUDE_SESSION_TYPE), query: { filters: [{ field: 'session', op: 'is', value: turn.session }], limit: 1 } });
    expect(listed.items).toHaveLength(1);
    // Claude asks to use Bash: a permit proposal for the person, as an approval in this chat; the approver says yes
    const permit = await approver.during(waitFor('Claude to finish the turn', async () => {
      const page = await me.hub.call('records', { type: QualifiedName.parse(CLAUDE_SESSION_TYPE), query: { filters: [{ field: 'session', op: 'is', value: turn.session }], limit: 1 } });
      const value = ClaudeSession.safeParse(page.items[0]?.value);
      return value.success && value.data.status === 'idle' && (value.data.lastText ?? '').includes('harness-ok') ? value.data : undefined;
    }, { timeout: TURN, every: 1_000 }));
    expect(permit.approvals.map((approval) => approval.fn)).toContain(qualify('claude', 'permit'));
    const proposed = permit.approvals.find((approval) => approval.fn === qualify('claude', 'permit'));
    const run = proposed === undefined ? undefined : await me.hub.call('run', { run: proposed.run });
    expect(run !== undefined && isSettled(run.status) ? run.status : 'open').toBe('done');
    // the approved permit let Claude write the file
    expect(readFileSync(join(folder, 'note.txt'), 'utf8')).toContain('harness-ok');
    await invoked('claude/control', { instance: turn.instance, session: turn.session, action: 'stop' }, turn.instance);
  }, 2 * TURN);
});
