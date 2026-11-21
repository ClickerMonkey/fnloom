/**
 * The api system's address guard and who sees a service, exploit-style (security review H7 and M9): `add_service`
 * refuses a loopback, link-local, LAN or private-resolving base URL and a private OpenAPI URL; every hop of a request
 * (a saved private base URL, a redirect off the base URL, a redirect whose name now resolves privately) and of the
 * OpenAPI fetch is checked; a private address is reached only on a service an admin allowed it on, which the agent
 * can never set; and a service an agent adds is its person's own (nobody else lists, uses, takes or connects to it)
 * until an admin shares it.
 */
import { ActorId, API_SERVICE_TYPE, ApiService, ConnectKey, Json, mintId, QualifiedName, type DataRecord, type UserInfo } from '@harness/core';
import { encodeValue } from '@harness/sdk';
import type { HostLookup } from '@harness/sdk/server';
import { mockModel, testHub, toolCall, type ScriptStep, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../shared/index.ts';
import { apiEnv } from './env.ts';
import { createApiImpl } from './impl.ts';

type Kit = TestSystem<'api', typeof api.defs>;

/** People runs are for: two members and an admin. */
const person = (id: string, role: UserInfo['role']): UserInfo => ({ id: ActorId.parse(id), name: id, email: `${id}@example.com`, role, groups: [], timeZone: 'UTC', locale: 'en' });
const ANN = person('act_ann', 'member');
const BEN = person('act_ben', 'member');
const ADMIN = person('act_admin', 'admin');

const OPENAPI = { openapi: '3.1.0', paths: { '/status': { get: { summary: 'Status' } }, '/user': { get: { summary: 'The user' } } } };
const BOARD = ApiService.parse({ name: 'board', label: 'Board', baseUrl: 'https://board.test/api' });

/** Where requests went. */
interface Sent { readonly method: string; readonly url: string }

/** Any host answers 200 with a little JSON (the OpenAPI document for `…/openapi.json`), or a redirect where `moves` says. */
function anywhere(sent: Sent[], moves: Record<string, string> = {}): typeof fetch {
  return (input, init) => {
    const url = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
    sent.push({ method: init?.method ?? 'GET', url });
    const to = moves[url];
    if (to !== undefined) return Promise.resolve(new Response(null, { status: 302, headers: { location: to } }));
    return Promise.resolve(new Response(JSON.stringify(url.endsWith('/openapi.json') ? OPENAPI : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
}

/** What hostnames resolve to: the answers given, else a public address (no DNS in tests). */
function lookupOf(answers: Record<string, () => readonly string[]> = {}): HostLookup {
  return (host) => Promise.resolve(answers[host]?.() ?? ['93.184.216.34']);
}

/** A service as the hub keeps it: a record of `api/Service`. */
function serviceRecord(service: ApiService): DataRecord {
  return { id: mintId('record'), type: API_SERVICE_TYPE, value: encodeValue(api.types.Service, service), title: service.label, version: 1, createdAt: 1, updatedAt: 1 };
}

let kit: Kit | undefined;
afterEach(async () => { await kit?.stop(); kit = undefined; });

async function start(script: readonly ScriptStep[], sent: Sent[], kept: readonly ApiService[], options: { moves?: Record<string, string>; lookup?: HostLookup } = {}): Promise<Kit> {
  kit = await testHub(api, createApiImpl({ settings: apiEnv.parse(), lookup: options.lookup ?? lookupOf() }), {
    model: mockModel(script), serve: { fetch: anywhere(sent, options.moves) }, records: kept.map(serviceRecord),
  });
  return kit;
}

/** A run of one of the system's fns for this person. */
const as = (running: Kit, user: UserInfo, fn: string) => ({ run: running.hub.runInfo(QualifiedName.parse(`api/${fn}`), { user }) });

/** Everything the model was told by a run's last step. */
const told = (running: Kit): string => JSON.stringify(running.hub.forwards.at(-1)?.request.messages ?? []);

describe('the address guard', () => {
  it('refuses add_service for a loopback, link-local, LAN or private-resolving base URL, or a private OpenAPI URL, and keeps nothing', async () => {
    const sent: Sent[] = [];
    const bases = ['http://127.0.0.1:4300/api', 'http://169.254.169.254/latest', 'http://192.168.50.113:8080', 'https://sneaky.test/v1'];
    const running = await start([
      ...bases.map((baseUrl, i) => toolCall('add_service', { name: `s${String(i)}`, label: 'S', baseUrl })),
      toolCall('add_service', { name: 'docs', label: 'Docs', baseUrl: 'https://docs.test', openapi: 'http://10.0.0.5/openapi.json' }),
      'None could be added.',
    ], sent, [], { lookup: lookupOf({ 'sneaky.test': () => ['127.0.0.1'] }) });
    await running.run('make_api', { request: 'Read the cloud metadata.' }, as(running, ANN, 'make_api'));
    for (const host of ['127.0.0.1', '169.254.169.254', '192.168.50.113', 'sneaky.test', '10.0.0.5']) expect(told(running)).toContain(`${host} is a private or local address`);
    expect(running.records('Service')).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('checks every hop: a saved private base URL, a redirect off the base URL, and a redirect whose name now resolves privately', async () => {
    const sent: Sent[] = [];
    const meta = ApiService.parse({ name: 'meta', label: 'Meta', baseUrl: 'http://169.254.169.254/latest' });
    const flip = ApiService.parse({ name: 'flip', label: 'Flip', baseUrl: 'https://flip.test/v1' });
    const hop = ApiService.parse({ name: 'hop', label: 'Hop', baseUrl: 'https://hop.test/v1' });
    let flips = 0;
    const running = await start([], sent, [meta, flip, hop], {
      moves: { 'https://flip.test/v1/a': '/v1/b', 'https://hop.test/v1/x': 'http://127.0.0.1:4300/admin' },
      // public when first checked, loopback by the redirect (a rebinding name)
      lookup: lookupOf({ 'flip.test': () => (flips++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']) }),
    });
    const tried = async (service: string, url: string) => JSON.stringify((await running.run('test_request', { service, url }, as(running, ANN, 'test_request'))).outcome);
    expect(await tried('meta', '/meta-data/iam')).toContain('169.254.169.254 is a private or local address');
    expect(await tried('flip', '/a')).toContain('flip.test is a private or local address');
    expect(await tried('hop', '/x')).toContain('outside its base URL');
    expect(sent.map((request) => request.url)).toEqual(['https://flip.test/v1/a', 'https://hop.test/v1/x']);
  });

  it('reads an OpenAPI document only through the guard, redirects too', async () => {
    const sent: Sent[] = [];
    const docs = ApiService.parse({ name: 'docs', label: 'Docs', baseUrl: 'https://docs.test', openapi: 'http://10.0.0.5/openapi.json' });
    const moved = ApiService.parse({ name: 'moved', label: 'Moved', baseUrl: 'https://moved.test', openapi: 'https://moved.test/openapi.json' });
    const running = await start([], sent, [docs, moved], { moves: { 'https://moved.test/openapi.json': 'http://127.0.0.1/openapi.json' } });
    const read = async (service: string) => (await running.run('operations', { service }, as(running, ANN, 'operations'))).outcome;
    const refused = await read('docs');
    expect(refused.status).toBe('failed');
    expect(JSON.stringify(refused)).toContain('10.0.0.5 is a private or local address');
    expect(JSON.stringify(await read('moved'))).toContain('127.0.0.1 is a private or local address');
    expect(sent.map((request) => request.url)).toEqual(['https://moved.test/openapi.json']);
  });

  it('reaches a private address only on a service an admin allowed it on, which the agent can never set', async () => {
    const sent: Sent[] = [];
    const local = ApiService.parse({ name: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:9000/api', openapi: 'http://127.0.0.1:9000/openapi.json', allowPrivate: true });
    const running = await start([
      toolCall('add_service', { name: 'lan', label: 'LAN', baseUrl: 'http://192.168.1.20', allowPrivate: true }),
      toolCall('add_service', { name: 'fresh', label: 'Fresh', baseUrl: 'https://fresh.test', allowPrivate: true, privateTo: BEN.id }),
      'Added.',
    ], sent, [local]);
    expect((await running.call('test_request', { service: 'local', url: '/status' }, as(running, ANN, 'test_request'))).result).toMatchObject({ url: 'http://127.0.0.1:9000/api/status', response: { status: 200 } });
    expect((await running.call('operations', { service: 'local' }, as(running, ANN, 'operations'))).result.total).toBe(2);
    await running.run('make_api', { request: 'Something on the LAN box.' }, as(running, ANN, 'make_api'));
    // the agent's allowPrivate (and whose it is) are dropped: only an admin sets them
    expect(JSON.stringify(running.hub.forwards[1]?.request.messages)).toContain('192.168.1.20 is a private or local address');
    expect(running.records('Service').map((record) => record.value)).toContainEqual(expect.objectContaining({ name: 'fresh', allowPrivate: false, privateTo: ANN.id }));
    expect(sent.map((request) => request.url)).toEqual(['http://127.0.0.1:9000/api/status', 'http://127.0.0.1:9000/openapi.json']);
  });
});

describe('services an agent adds', () => {
  it('are their person\'s own until an admin shares them: nobody else lists, uses, takes or connects to one', async () => {
    const sent: Sent[] = [];
    const github = { name: 'github', label: 'GitHub', baseUrl: 'https://api.github.test', auth: { kind: 'bearer', per: 'person' } };
    const running = await start([
      toolCall('add_service', github), 'Added.',
      toolCall('add_service', { ...github, baseUrl: 'https://evil.test' }), 'Taken.',
    ], sent, [BOARD]);
    await running.run('make_api', { request: 'GitHub issues.' }, as(running, ANN, 'make_api'));
    const record = running.records('Service').find((kept) => ApiService.parse(kept.value).name === 'github');
    if (record === undefined) throw new Error('expected the added service');
    expect(record.value).toMatchObject({ name: 'github', privateTo: ANN.id, allowPrivate: false });
    const names = async (user: UserInfo) => (await running.call('services', {}, as(running, user, 'services'))).result.items.map((service) => service.name);
    expect(await names(ANN)).toEqual(['github', 'board']);
    expect(await names(BEN)).toEqual(['board']);
    expect(await names(ADMIN)).toEqual(['board', 'github']);
    expect(JSON.stringify((await running.run('test_request', { service: 'github', url: '/user' }, as(running, BEN, 'test_request'))).outcome)).toContain('There is no API service github');
    const finish = (owner: UserInfo) => running.hub.connectFinish({
      connection: mintId('connection'), owner: owner.id, key: ConnectKey.parse('github'), redirect: 'https://hub.test/connect/callback', answer: { form: { token: 'a-token' } },
    });
    expect(JSON.stringify(await finish(BEN))).toContain('no API service github');
    expect(await finish(ANN)).toMatchObject({ credentials: { token: 'a-token', baseUrl: 'https://api.github.test' } });
    // the name is taken for everyone: Ben's agent can't claim it with another base URL
    await running.run('make_api', { request: 'GitHub issues.' }, as(running, BEN, 'make_api'));
    expect(told(running)).toContain('There is an API service named github already');
    expect(running.records('Service')).toHaveLength(2);
    // an admin shares it (clears privateTo on the API services page): then everyone sees it
    const { privateTo: _shared, ...rest } = ApiService.parse(record.value);
    running.hub.data.save({ type: record.type, id: record.id, value: Json.parse(rest) });
    expect(await names(BEN)).toEqual(['board', 'github']);
    expect(sent).toEqual([]);
  });
});
