/**
 * The api system (one instance, its services records) with the SDK test kit, a scripted model and a fake service:
 * `make_api`'s forced workflow on a service it is given (a POST with two body slots refused, a GET sent with its
 * sample and mapped by its output program, saved for the service with no routing), and on none (the agent adds the
 * service from its base URL, then writes for it); the `request` kind's describe (the method read off the program, the
 * service as the fn's connection key) and runs (sent to the service the payload names, signed with the run's
 * connection, which the trace masks; a connection given for another base URL refused; a url leaving the base URL
 * refused); `services` and `operations`; and connecting per service with a typed token, shared or per person.
 */
import { API_KIND, API_SERVICE_TYPE, ApiService, ConnectKey, mintId, QualifiedName, type ApiFnSpec, type DataRecord, type Json, type LlmForward, type RunConnection } from '@harness/core';
import { encodeValue, sampleArgs } from '@harness/sdk';
import type { HostLookup } from '@harness/sdk/server';
import { mockModel, testHub, toolCall, type ScriptStep, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { api, ApiPayload, HttpRequest } from '../shared/index.ts';
import { API_EXAMPLES } from './authoring.ts';
import { apiEnv } from './env.ts';
import { authHeaders, NoCredential, prepare } from './http.ts';
import { createApiImpl } from './impl.ts';

type Kit = TestSystem<'api', typeof api.defs>;

const TRACKER = ApiService.parse({
  name: 'tracker', label: 'Tracker', baseUrl: 'https://tracker.test/v1', auth: { kind: 'bearer', per: 'shared' }, openapi: 'https://tracker.test/openapi.json',
});
const BOARD = ApiService.parse({ name: 'board', label: 'Board', baseUrl: 'https://board.test/api', auth: { kind: 'none' } });
const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/repos/{owner}/{repo}/issues': { get: { summary: 'List issues', operationId: 'issues/list' }, post: { summary: 'Create an issue', operationId: 'issues/create' }, parameters: [] },
    '/user': { get: { summary: 'The signed-in user' } },
  },
};

/** A connection to a service as the hub sends it with a run: the credentials bound to the base URL they were set for. */
const connected = (token: string, service: ApiService = TRACKER, owner = mintId('actor')) => ({
  connection: { id: mintId('connection'), owner, credentials: { token, baseUrl: service.baseUrl }, settings: {} },
});

/** What the fake services were sent. */
interface Sent { readonly method: string; readonly url: string; readonly auth: string | null; readonly body: string | null }

/** The fake services: the tracker's OpenAPI document, open issues and creating an issue; the board's cards. */
function services(sent: Sent[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';
    sent.push({ method, url, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    const json = (status: number, value: Json) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
    if (url === 'https://tracker.test/openapi.json') return json(200, OPENAPI);
    if (method === 'GET' && url === 'https://tracker.test/v1/repos/acme/web/issues?state=open') return json(200, [{ number: 1, title: 'Bug' }, { number: 2, title: 'Idea' }]);
    if (method === 'GET' && url === 'https://tracker.test/v1/repos/acme/web') return json(200, { name: 'web', stargazers_count: 42 });
    if (method === 'POST' && url === 'https://tracker.test/v1/repos/acme/web/issues') return json(201, { number: 7 });
    if (method === 'GET' && url === 'https://board.test/api/repos/acme/web/issues?state=open') return json(200, [{ number: 9, title: 'Card' }]);
    const moved = (location: string) => Promise.resolve(new Response(null, { status: 302, headers: { location } }));
    if (url === 'https://tracker.test/v1/old/web') return moved('/v1/repos/acme/web');
    if (url === 'https://tracker.test/v1/away') return moved('https://elsewhere.test/steal');
    if (url === 'https://tracker.test/v1/repos/acme/old') return moved('/v1/repos/acme/web/issues');
    return json(404, { message: 'Not Found' });
  };
}

const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

/** A service as the hub keeps it: a record of `api/Service`. */
function serviceRecord(service: ApiService): DataRecord {
  return { id: mintId('record'), type: API_SERVICE_TYPE, value: encodeValue(api.types.Service, service), title: service.label, version: 1, createdAt: 1, updatedAt: 1 };
}

let kit: Kit | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

/** Every hostname resolves to a public address (no DNS in tests; the guard's own cases are in `guard.test.ts`). */
const lookupOf = (): HostLookup => () => Promise.resolve(['93.184.216.34']);

async function start(script: readonly ScriptStep[], sent: Sent[], kept: readonly ApiService[] = [TRACKER, BOARD]): Promise<Kit> {
  kit = await testHub(api, createApiImpl({ settings: apiEnv.parse(), lookup: lookupOf() }), { model: mockModel(script), serve: { fetch: services(sent) }, records: kept.map(serviceRecord) });
  return kit;
}

const SERVICE = ConnectKey.parse('tracker');
const ISSUES: ApiFnSpec = { service: SERVICE, ...API_EXAMPLES.openIssues.signature, request: API_EXAMPLES.openIssues.request };
const CREATE: ApiFnSpec = {
  service: SERVICE, args: { name: 'obj', props: { owner: { type: { name: 'text' } }, repo: { type: { name: 'text' } }, title: { type: { name: 'text' } } } },
  returns: { name: 'obj', props: { number: { type: { name: 'num' } } } }, request: API_EXAMPLES.createIssue.request,
};

describe('make_api', () => {
  it('on a service it is given: reads its operations, refuses two body slots, sends the GET with its sample, maps it and saves it for the service', async () => {
    const sent: Sent[] = [];
    // a body (written as the strict schema has it, a new api/HttpBody) that sets two slots
    const twoSlots = { ...API_EXAMPLES.createIssue.request, value: { ...API_EXAMPLES.createIssue.request.value, body: { kind: 'new', type: { name: 'api/HttpBody' }, value: { json: { kind: 'new', type: { name: 'obj' }, value: {} }, text: 'x' } } } };
    const { repo } = API_EXAMPLES;
    const draft = { name: 'repo_stars', description: 'The name and stars of a repository.', request: repo.request, responseType: repo.responseType, output: repo.output, sample: { owner: 'acme', repo: 'web' } };
    const running = await start([
      toolCall('search', { text: 'open issues' }),
      toolCall('operations', { text: 'issues' }),
      toolCall('examples', {}),
      toolCall('signature', API_EXAMPLES.repo.signature),
      toolCall('set', { draft: { ...draft, request: twoSlots, output: undefined, responseType: undefined } }),
      toolCall('set', { draft }),
      toolCall('return', {}),
      'Saved api/tracker.repo_stars.',
    ], sent);
    const fake = running.hub;
    const { result } = await running.call('make_api', { request: 'The name and stars of a repository.', service: 'tracker' }, connected('secret-token'));
    expect(result).toMatchObject({ fn: 'api/tracker.repo_stars', version: 1, reused: false, preview: { name: 'web', stars: 42 } });
    const saved = fake.fns.kept.get('api/tracker.repo_stars')?.saved;
    expect(saved).toMatchObject({ kind: API_KIND, payload: { service: 'tracker' }, tags: ['api', 'tracker'] });
    // the one instance runs every api fn: none is routed to an instance
    expect(saved?.routing).toBeUndefined();
    // the service is given, so the service tools are not offered
    expect(offered(fake.forwards[0])).toEqual(['search']);
    expect(offered(fake.forwards[1])).toEqual(expect.arrayContaining(['operations', 'signature', 'examples']));
    expect(JSON.stringify(fake.forwards[2]?.request.messages)).toContain('issues/create');
    expect(JSON.stringify(fake.forwards[5]?.request.messages)).toContain('exactly one body slot');
    // only the GET (and the OpenAPI document) went out while writing, signed with the run's connection to the service
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual(['GET https://tracker.test/openapi.json', 'GET https://tracker.test/v1/repos/acme/web']);
    expect(sent[1]?.auth).toBe('Bearer secret-token');
  });

  it('on no service: the agent adds it from the base URL (no secret in it), then writes for it', async () => {
    const sent: Sent[] = [];
    const draft = { name: 'cards', description: 'The open cards of a board.', request: API_EXAMPLES.openIssues.request, sample: { owner: 'acme', repo: 'web' } };
    const running = await start([
      toolCall('services', { text: 'cards' }),
      toolCall('add_service', { name: 'cards', label: 'Cards', baseUrl: 'https://board.test/api', auth: { kind: 'none' } }),
      toolCall('signature', API_EXAMPLES.openIssues.signature),
      toolCall('set', { draft }),
      toolCall('return', {}),
      'Saved api/cards.cards.',
    ], sent, []);
    const { result } = await running.call('make_api', { request: 'The open cards of the board at https://board.test/api.' });
    expect(result).toMatchObject({ fn: 'api/cards.cards', preview: [{ number: 9, title: 'Card' }] });
    expect(running.records('Service').map((record) => record.value)).toEqual([expect.objectContaining({ name: 'cards', baseUrl: 'https://board.test/api', auth: { kind: 'none' } })]);
    expect(running.hub.fns.kept.get('api/cards.cards')?.saved).toMatchObject({ payload: { service: 'cards' } });
    // the service tools were offered first, and withdrawn once it was added
    expect(offered(running.hub.forwards[0])).toEqual(expect.arrayContaining(['services', 'use_service', 'add_service', 'search']));
    expect(offered(running.hub.forwards[2])).not.toContain('add_service');
  });

  it('refuses a service it is given that is not there, and one the agent adds that is', async () => {
    const running = await start([toolCall('add_service', { name: 'tracker', label: 'Again', baseUrl: 'https://x.test' }), 'There is one.'], []);
    expect(JSON.stringify((await running.run('make_api', { request: 'x', service: 'nowhere' })).outcome)).toContain('There is no API service nowhere');
    await running.run('make_api', { request: 'Issues of the tracker.' });
    expect(JSON.stringify(running.hub.forwards[1]?.request.messages)).toContain('There is an API service named tracker already');
    expect(running.records('Service')).toHaveLength(2);
  });
});

describe('the request kind', () => {
  const run = (running: Kit, spec: ApiFnSpec, args: Json, extra: { connection?: RunConnection } = connected('secret-token')) => running.hub.run(QualifiedName.parse(`api/${spec.service}.fn`), args, { kind: API_KIND, payload: encodeValue(ApiPayload, spec), ...extra });

  it('reads the method off the program (a GET reads, a POST writes) and names its service as the connection key', async () => {
    const running = await start([], []);
    expect((await running.kindProps('request', ISSUES)).description).toMatchObject({ effects: { mode: 'read' }, deps: [], args: ISSUES.args, connectKey: 'tracker' });
    expect((await running.kindProps('request', CREATE)).description).toMatchObject({ effects: { mode: 'write' }, connectKey: 'tracker' });
    // its example: its args filled with sample values read off its schema
    expect((await running.kindProps('request', ISSUES)).description?.examples).toEqual([{ args: sampleArgs(ISSUES.args), note: `A GET request to the ${ISSUES.service} service, with sample values: use real ones.` }]);
    // its page reads the method, the service and both programs
    const readable = (await running.kindProps('request', ISSUES)).description?.readable;
    expect(readable?.code).toContain(`// Sends GET to the ${ISSUES.service} service:`);
    expect(readable?.code).toContain('// The result is the response body.');
    const computed = { ...CREATE, request: { kind: 'new', type: { name: 'api/HttpRequest' }, value: { ...API_EXAMPLES.createIssue.request.value, method: { kind: 'get', path: [{ prop: 'args' }, { prop: 'title' }] } } } };
    expect((await running.kindProps('request', computed)).problems.join('\n')).toContain('write `method` literally');
  });

  it('never sends a method the program changed after the one it was checked by', async () => {
    const sent: Sent[] = [];
    const running = await start([], sent);
    const request = { kind: 'new', type: { name: 'api/HttpRequest' }, value: { method: 'GET', url: '/repos/acme/web' } };
    const changed = {
      ...ISSUES,
      request: {
        kind: 'define', vars: [{ name: 'r', value: request }],
        body: { kind: 'block', lines: [{ kind: 'set', path: [{ prop: 'r' }, { prop: 'method' }], value: { kind: 'new', type: { name: 'text' }, value: 'DELETE' } }, { kind: 'get', path: [{ prop: 'r' }] }] },
      },
    };
    expect((await running.kindProps('request', changed)).description).toMatchObject({ effects: { mode: 'read' } });
    expect(JSON.stringify(await run(running, changed, { owner: 'acme', repo: 'web' }))).toContain('checked as GET but built as DELETE');
    expect(sent).toEqual([]);
  });

  it('runs on the service its payload names, signed with the run\'s connection, masks it in the trace, and refuses a url that leaves the base URL', async () => {
    const sent: Sent[] = [];
    const running = await start([], sent);
    expect(await run(running, ISSUES, { owner: 'acme', repo: 'web' })).toMatchObject({ status: 'done', result: [{ number: 1, title: 'Bug' }, { number: 2, title: 'Idea' }] });
    expect(await run(running, CREATE, { owner: 'acme', repo: 'web', title: 'New' })).toMatchObject({ status: 'done', result: { number: 7 } });
    expect(sent.map((request) => request.body)).toEqual([null, '{"title":"New"}']);
    expect(sent.map((request) => request.auth)).toEqual(['Bearer secret-token', 'Bearer secret-token']);
    // the same program for the board goes to the board's base URL, with no sign-in
    expect(await run(running, { ...ISSUES, service: ConnectKey.parse('board') }, { owner: 'acme', repo: 'web' }, {})).toMatchObject({ status: 'done', result: [{ number: 9, title: 'Card' }] });
    expect(sent.at(-1)).toMatchObject({ url: 'https://board.test/api/repos/acme/web/issues?state=open', auth: null });
    const exchange = await running.call('test_request', { service: 'tracker', url: '/repos/acme/web/issues', params: [{ key: 'state', value: 'open' }] }, connected('secret-token'));
    expect(exchange.result.headers.find((header) => header.key === 'authorization')?.value).toMatch(/^••••/);
    expect(JSON.stringify(exchange.result)).not.toContain('secret-token');
    const escape = { ...ISSUES, request: { kind: 'new', type: { name: 'api/HttpRequest' }, value: { method: 'GET', url: '../../admin' } } };
    expect(JSON.stringify(await run(running, escape, { owner: 'acme', repo: 'web' }))).toContain('leaves the service');
    const absolute = await running.run('test_request', { service: 'tracker', url: 'https://elsewhere.test/x' }, connected('secret-token'));
    expect(absolute.outcome.status).toBe('invalid-input');
    // a redirect is followed only under the base URL, and a write is never sent again
    expect((await running.call('test_request', { service: 'tracker', url: '/old/web' }, connected('secret-token'))).result).toMatchObject({ url: 'https://tracker.test/v1/repos/acme/web', response: { status: 200 } });
    expect((await running.run('test_request', { service: 'tracker', url: '/away' }, connected('secret-token'))).outcome.status).toBe('invalid-input');
    expect(sent.some((request) => request.url.startsWith('https://elsewhere.test'))).toBe(false);
    const movedPost = { ...CREATE, request: { ...API_EXAMPLES.createIssue.request, value: { ...API_EXAMPLES.createIssue.request.value, url: '/repos/acme/old' } } };
    expect(JSON.stringify(await run(running, movedPost, { owner: 'acme', repo: 'web', title: 'New' }))).toContain('not sent again');
  });

  it('asks to connect when the run has no connection to the service, and refuses one given for another base URL', async () => {
    const sent: Sent[] = [];
    const running = await start([], sent);
    expect(await run(running, ISSUES, { owner: 'acme', repo: 'web' }, {})).toMatchObject({ status: 'failed', error: { code: 'not-connected' } });
    // a token set before the service's base URL was changed is never sent to the new one
    const moved = { connection: { ...connected('secret-token').connection, credentials: { token: 'secret-token', baseUrl: 'https://old.test' } } };
    expect(JSON.stringify(await run(running, ISSUES, { owner: 'acme', repo: 'web' }, moved))).toContain('base URL changed');
    expect(sent).toEqual([]);
    // a run gone missing its service fails plainly
    expect(JSON.stringify(await run(running, { ...ISSUES, service: ConnectKey.parse('gone') }, { owner: 'acme', repo: 'web' }))).toContain('which is gone');
  });

  it('lists the services and pages the operations of a service\'s OpenAPI document', async () => {
    const running = await start([], []);
    expect((await running.call('services', {})).result.items.map((service) => service.name)).toEqual(['board', 'tracker']);
    expect((await running.call('services', { text: 'tracker.test' })).result.items.map((service) => service.name)).toEqual(['tracker']);
    const { result } = await running.call('operations', { service: 'tracker', text: 'issues', limit: 1 });
    expect(result).toEqual({ items: [{ method: 'GET', path: '/repos/{owner}/{repo}/issues', summary: 'List issues', operationId: 'issues/list' }], total: 2, next: 1 });
    expect((await running.run('operations', { service: 'board' })).outcome.status).toBe('failed');
  });
});

describe('connecting per service', () => {
  const finish = (running: Kit, key: string, form: Json) => running.hub.connectFinish({
    connection: mintId('connection'), owner: mintId('actor'), key: ConnectKey.parse(key), redirect: 'https://hub.test/connect/callback', answer: { form },
  });

  it('keeps a typed token bound to the service\'s base URL, shared or per person', async () => {
    const own = ApiService.parse({ name: 'mine', label: 'Mine', baseUrl: 'https://mine.test', auth: { kind: 'headers', per: 'person', names: ['X-Key'] } });
    const running = await start([], [], [TRACKER, own]);
    // a shared token: one admin types it for everyone (the hub lets only an admin make that connection)
    expect(await finish(running, 'tracker', { token: 'shared-token' })).toEqual({
      account: { label: 'Tracker', detail: 'Token ending oken' }, credentials: { token: 'shared-token', baseUrl: 'https://tracker.test/v1' },
    });
    expect(await finish(running, 'mine', { 'X-Key': 'k1' })).toMatchObject({ account: { label: 'Mine' }, credentials: { headers: { 'X-Key': 'k1' }, baseUrl: 'https://mine.test' } });
    const anyProblem: unknown = expect.any(String);
    const noService: unknown = expect.stringContaining('no API service nowhere');
    expect(await finish(running, 'mine', {})).toMatchObject({ problem: anyProblem });
    expect(await finish(running, 'nowhere', { token: 't' })).toMatchObject({ problem: noService });
  });

  it('signs with what a connection keeps, and never with one for another base URL', () => {
    expect(authHeaders(TRACKER, { token: 't', baseUrl: TRACKER.baseUrl })).toEqual({ authorization: 'Bearer t' });
    expect(() => authHeaders(TRACKER, undefined)).toThrow(NoCredential);
    expect(() => authHeaders(TRACKER, { token: 't', baseUrl: 'https://evil.test' })).toThrow(/base URL changed/);
    expect(authHeaders(BOARD, undefined)).toEqual({});
  });
});

describe('file bodies', () => {
  const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
  const how = { credentials: { token: 't', baseUrl: TRACKER.baseUrl }, bytes: () => Promise.resolve(BYTES) };

  it('sends a binary body and a multipart file part as the resource\'s bytes, not its text', async () => {
    const binary = await prepare(HttpRequest.parse({ method: 'PUT', url: '/files/logo', body: { binary: 'fs://home/logo.png' } }), TRACKER, how);
    expect(binary.init.body).toEqual(BYTES);
    expect(new Headers(binary.init.headers).get('content-type')).toBe('application/octet-stream');
    const multipart = await prepare(HttpRequest.parse({ method: 'POST', url: '/files', body: { multipart: [{ name: 'note', value: 'hi' }, { name: 'file', resource: 'fs://home/logo.png', filename: 'logo.png', contentType: 'image/png' }] } }), TRACKER, how);
    const form = multipart.init.body;
    if (!(form instanceof FormData)) throw new Error('expected a multipart form');
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new Error('expected a file part');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
    expect(form.get('note')).toBe('hi');
  });
});
