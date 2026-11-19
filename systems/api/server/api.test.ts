/**
 * The api system with the SDK test kit, a scripted model and a fake service: `make_api`'s forced workflow (a POST with
 * two body slots refused, a GET sent with its sample and mapped by its output program, saved as a fn of the service);
 * the `request` kind's describe (the method read off the program: a POST writes) and runs (signed with the service's
 * token, which the trace masks; a url leaving the base URL refused; a person's credentials from the connection);
 * `operations` paged from the OpenAPI document; and connecting with a typed token.
 */
import { API_KIND, InstanceName, QualifiedName, mintId, type ApiFnSpec, type ApiServiceConfig, type Json, type LlmForward } from '@harness/core';
import { encodeValue, sampleArgs } from '@harness/sdk';
import { mockModel, testHub, toolCall, type ScriptStep, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { api, ApiPayload, HttpRequest } from '../shared/index.ts';
import { API_EXAMPLES } from './authoring.ts';
import { apiEnv } from './env.ts';
import { prepare } from './http.ts';
import { createApiImpl } from './impl.ts';

type Kit = TestSystem<'api', typeof api.defs>;

const SERVICE = InstanceName.parse('tracker');
const CONFIG: ApiServiceConfig = {
  label: 'Tracker', baseUrl: 'https://tracker.test/v1', auth: { kind: 'bearer', per: 'shared', token: 'secret-token' },
  openapi: 'https://tracker.test/openapi.json', timeout: 60_000, maxBody: 2_000_000,
};
const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/repos/{owner}/{repo}/issues': { get: { summary: 'List issues', operationId: 'issues/list' }, post: { summary: 'Create an issue', operationId: 'issues/create' }, parameters: [] },
    '/user': { get: { summary: 'The signed-in user' } },
  },
};

/** What the fake service was sent. */
interface Sent { readonly method: string; readonly url: string; readonly auth: string | null; readonly body: string | null }

/** The fake service: its OpenAPI document, open issues, and creating an issue. */
function service(sent: Sent[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    const method = init?.method ?? 'GET';
    sent.push({ method, url, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    const json = (status: number, value: Json) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));
    if (url === 'https://tracker.test/openapi.json') return json(200, OPENAPI);
    if (method === 'GET' && url === 'https://tracker.test/v1/repos/acme/web/issues?state=open') return json(200, [{ number: 1, title: 'Bug' }, { number: 2, title: 'Idea' }]);
    if (method === 'GET' && url === 'https://tracker.test/v1/repos/acme/web') return json(200, { name: 'web', stargazers_count: 42 });
    if (method === 'POST' && url === 'https://tracker.test/v1/repos/acme/web/issues') return json(201, { number: 7 });
    const moved = (location: string) => Promise.resolve(new Response(null, { status: 302, headers: { location } }));
    if (url === 'https://tracker.test/v1/old/web') return moved('/v1/repos/acme/web');
    if (url === 'https://tracker.test/v1/away') return moved('https://elsewhere.test/steal');
    if (url === 'https://tracker.test/v1/repos/acme/old') return moved('/v1/repos/acme/web/issues');
    return json(404, { message: 'Not Found' });
  };
}

const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

let kit: Kit | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

async function start(script: readonly ScriptStep[], sent: Sent[], config: ApiServiceConfig = CONFIG): Promise<Kit> {
  kit = await testHub(api, createApiImpl({ settings: apiEnv.parse() }), { config, model: mockModel(script), hub: { instance: SERVICE }, serve: { fetch: service(sent) } });
  return kit;
}

const ISSUES: ApiFnSpec = { service: SERVICE, ...API_EXAMPLES.openIssues.signature, request: API_EXAMPLES.openIssues.request };
const CREATE: ApiFnSpec = {
  service: SERVICE, args: { name: 'obj', props: { owner: { type: { name: 'text' } }, repo: { type: { name: 'text' } }, title: { type: { name: 'text' } } } },
  returns: { name: 'obj', props: { number: { type: { name: 'num' } } } }, request: API_EXAMPLES.createIssue.request,
};

describe('make_api', () => {
  it('reads the operations, refuses two body slots, sends the GET with its sample, maps it and saves it on the service', async () => {
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
    const { result } = await running.call('make_api', { request: 'The name and stars of a repository.' });
    expect(result).toMatchObject({ fn: 'api/tracker.repo_stars', version: 1, reused: false, preview: { name: 'web', stars: 42 } });
    expect(fake.fns.kept.get('api/tracker.repo_stars')?.saved).toMatchObject({ kind: API_KIND, routing: { to: 'instance', instance: 'tracker' }, payload: { service: 'tracker' } });
    expect(offered(fake.forwards[0])).toEqual(['search']);
    expect(offered(fake.forwards[1])).toEqual(expect.arrayContaining(['operations', 'signature', 'examples']));
    expect(JSON.stringify(fake.forwards[2]?.request.messages)).toContain('issues/create');
    expect(JSON.stringify(fake.forwards[5]?.request.messages)).toContain('exactly one body slot');
    // only the GET (and the OpenAPI document) went out while writing; the refused POST never did
    expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual(['GET https://tracker.test/openapi.json', 'GET https://tracker.test/v1/repos/acme/web']);
    expect(sent[1]?.auth).toBe('Bearer secret-token');
  });
});

describe('the request kind', () => {
  const run = (running: Kit, spec: ApiFnSpec, args: Json) => running.hub.run(QualifiedName.parse('api/tracker.fn'), args, { kind: API_KIND, payload: encodeValue(ApiPayload, spec) });

  it('reads the method off the program: a GET reads, a POST writes', async () => {
    const running = await start([], []);
    expect((await running.kindProps('request', ISSUES)).description).toMatchObject({ effects: { mode: 'read' }, deps: [], args: ISSUES.args });
    expect((await running.kindProps('request', CREATE)).description).toMatchObject({ effects: { mode: 'write' } });
    // its example: its args filled with sample values read off its schema
    expect((await running.kindProps('request', ISSUES)).description?.examples).toEqual([{ args: sampleArgs(ISSUES.args), note: `A GET request to the ${ISSUES.service} service, with sample values: use real ones.` }]);
    // its page reads the method, the service and both programs
    const readable = (await running.kindProps('request', ISSUES)).description?.readable;
    expect(readable?.code).toContain(`// Sends GET to the ${ISSUES.service} service:`);
    expect(readable?.code).toContain(ISSUES.output === undefined ? '// The result is the response body.' : '// The result, read from `response`:');
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

  it('runs signed with the service\'s token, masks it in the trace, and refuses a url that leaves the base URL', async () => {
    const sent: Sent[] = [];
    const running = await start([], sent);
    expect(await run(running, ISSUES, { owner: 'acme', repo: 'web' })).toMatchObject({ status: 'done', result: [{ number: 1, title: 'Bug' }, { number: 2, title: 'Idea' }] });
    expect(await run(running, CREATE, { owner: 'acme', repo: 'web', title: 'New' })).toMatchObject({ status: 'done', result: { number: 7 } });
    expect(sent.map((request) => request.body)).toEqual([null, '{"title":"New"}']);
    const exchange = await running.call('test_request', { url: '/repos/acme/web/issues', params: [{ key: 'state', value: 'open' }] });
    expect(exchange.result.headers.find((header) => header.key === 'authorization')?.value).toMatch(/^••••/);
    expect(JSON.stringify(exchange.result)).not.toContain('secret-token');
    const escape = { ...ISSUES, request: { kind: 'new', type: { name: 'api/HttpRequest' }, value: { method: 'GET', url: '../../admin' } } };
    expect(JSON.stringify(await run(running, escape, { owner: 'acme', repo: 'web' }))).toContain('leaves the service');
    const absolute = await running.run('test_request', { url: 'https://elsewhere.test/x' });
    expect(absolute.outcome.status).toBe('invalid-input');
    // a redirect is followed only under the base URL, and a write is never sent again
    expect((await running.call('test_request', { url: '/old/web' })).result).toMatchObject({ url: 'https://tracker.test/v1/repos/acme/web', response: { status: 200 } });
    expect((await running.run('test_request', { url: '/away' })).outcome.status).toBe('invalid-input');
    expect(sent.some((request) => request.url.startsWith('https://elsewhere.test'))).toBe(false);
    const movedPost = { ...CREATE, request: { ...API_EXAMPLES.createIssue.request, value: { ...API_EXAMPLES.createIssue.request.value, url: '/repos/acme/old' } } };
    expect(JSON.stringify(await run(running, movedPost, { owner: 'acme', repo: 'web', title: 'New' }))).toContain('not sent again');
  });

  it('signs with the person\'s own token, and asks them to connect when they have none', async () => {
    const sent: Sent[] = [];
    const running = await start([], sent, { ...CONFIG, auth: { kind: 'bearer', per: 'person' } });
    expect(await run(running, ISSUES, { owner: 'acme', repo: 'web' })).toMatchObject({ status: 'failed', error: { code: 'not-connected' } });
    const connected = await running.hub.connectFinish({ connection: mintId('connection'), owner: mintId('actor'), instance: SERVICE, redirect: 'https://hub.test/connect/callback', answer: { form: { token: 'ann-token' } } });
    expect(connected).toMatchObject({ account: { label: 'Tracker', detail: 'Token ending oken' }, credentials: { token: 'ann-token' } });
    expect(running.hub.instanceConnects.at(-1)).toMatchObject({ flow: { flow: 'form' }, title: 'Connect to Tracker' });
    const outcome = await running.hub.run(QualifiedName.parse('api/tracker.fn'), { owner: 'acme', repo: 'web' }, {
      kind: API_KIND, payload: encodeValue(ApiPayload, ISSUES), connection: { id: mintId('connection'), owner: mintId('actor'), credentials: { token: 'ann-token' }, settings: {} },
    });
    expect(outcome.status).toBe('done');
    expect(sent.at(-1)?.auth).toBe('Bearer ann-token');
  });

  it('pages the operations of the OpenAPI document', async () => {
    const running = await start([], []);
    const { result } = await running.call('operations', { text: 'issues', limit: 1 });
    expect(result).toEqual({ items: [{ method: 'GET', path: '/repos/{owner}/{repo}/issues', summary: 'List issues', operationId: 'issues/list' }], total: 2, next: 1 });
  });
});

describe('file bodies', () => {
  const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
  const how = { credentials: undefined, bytes: () => Promise.resolve(BYTES) };

  it('sends a binary body and a multipart file part as the resource\'s bytes, not its text', async () => {
    const binary = await prepare(HttpRequest.parse({ method: 'PUT', url: '/files/logo', body: { binary: 'fs://home/logo.png' } }), CONFIG, how);
    expect(binary.init.body).toEqual(BYTES);
    expect(new Headers(binary.init.headers).get('content-type')).toBe('application/octet-stream');
    const multipart = await prepare(HttpRequest.parse({ method: 'POST', url: '/files', body: { multipart: [{ name: 'note', value: 'hi' }, { name: 'file', resource: 'fs://home/logo.png', filename: 'logo.png', contentType: 'image/png' }] } }), CONFIG, how);
    const form = multipart.init.body;
    if (!(form instanceof FormData)) throw new Error('expected a multipart form');
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new Error('expected a file part');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
    expect(form.get('note')).toBe('hi');
  });
});
