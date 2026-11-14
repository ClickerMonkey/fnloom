/**
 * The production modules put together: the hub starts with every real module (an in-memory database, a scripted
 * model), serves its own contract, and stops cleanly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent, fn, g, hub as hubContract, manifestOf, system } from '@harness/sdk';
import { mintId, QualifiedName, ResourceUri, SystemName, type UserView } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingPush, testSettings } from '../api/testing/rig.ts';
import { memoryLog } from '../testing.ts';
import { SCRIPTED_AS, ScriptedProvider, TEST_MODEL, says } from '../execution/testing.ts';
import type { RunningHub } from './index.ts';
import { HubFns } from '../execution/executors.ts';
import { registerRunFns } from '../execution/hub-fns.ts';
import { hubModules, registerHubContract } from './modules.ts';
import { adminReadOperations, exploreOperations, personOperations } from '../api/person-ops.ts';
import { startHub } from './start.ts';

const dir = mkdtempSync(join(tmpdir(), 'harness-modules-'));
let running: RunningHub;
const provider = new ScriptedProvider();

beforeAll(async () => {
  const base = testSettings();
  running = await startHub({
    port: 0, log: memoryLog().log, pushSender: recordingPush(), signals: false,
    keyMaker: { secret: () => 'k'.repeat(48), vapid: () => ({ publicKey: 'pub', privateKey: 'priv' }) },
    settings: {
      ...base,
      hubEnv: { ...base.hubEnv, HARNESS_DB_FILE: ':memory:', HARNESS_KEYS_FILE: join(dir, 'keys.json'), HARNESS_FILES_DIR: join(dir, 'files'), HARNESS_SYSTEMS_DIR: join(dir, 'systems') },
      logEnv: { ...base.logEnv, HARNESS_LOG_FILES: false },
    },
    modules: hubModules({ llm: () => ({ providers: { [SCRIPTED_AS]: provider }, models: [TEST_MODEL] }) }),
  });
});

afterAll(async () => {
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('the hub with its real modules', () => {
  it('imports its own contract, so its chat agent and fns resolve like any system’s', async () => {
    const { catalog } = running.services;
    expect((await catalog.fn(hubContract.fns.chat.name))?.decl.kind).toBe('hub/llm');
    const names = (await catalog.fns({ system: SystemName.parse('hub') })).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(Object.values(hubContract.fns).map((f) => f.name)));
  });

  it('implements every native fn the hub contract declares', () => {
    const fns = new HubFns();
    registerRunFns(fns, { get: () => Promise.resolve(undefined), wait: () => Promise.reject(new Error('not waited on while registering')) });
    registerHubContract({ hubFns: fns, handlers: { askPerson: () => Promise.reject(new Error('not asked while registering')) } }, running.services);
    const native = Object.entries(hubContract.defs.fns).filter(([, decl]) => decl.kind === 'native').map(([local]) => QualifiedName.parse(`hub/${local}`));
    expect(native.length).toBeGreaterThan(0);
    expect(native.filter((name) => !fns.has(name))).toEqual([]);
  });

  it('offers the models of the providers it was given', async () => {
    expect((await running.services.execution.llm.models()).map((m) => m.id)).toContain(TEST_MODEL.id);
  });

  it('starts a session answered by its chat agent, with the systems and suggestions wired', async () => {
    const owner = mintId('actor');
    await running.services.store.table('actors').insert({ id: owner, kind: 'user', name: 'Ada', about: '', email: 'ada@example.com', role: 'admin', createdAt: 1, disabled: false });
    const session = await running.services.chat.sessions.create({ owner });
    expect(session.agent).toBe('hub/chat');
    await expect(running.services.index.suggest.suggest({ session: session.id, text: 'hello', limit: 3 })).resolves.toEqual(expect.any(Array));
    expect(running.services.link.connections.connected()).toEqual([]);
  });

  it('serves the person operations and the admin reads over the real modules', async () => {
    const id = mintId('actor');
    await running.services.store.table('actors').insert({ id, kind: 'user', name: 'Bo', about: '', email: 'bo@example.com', role: 'admin', createdAt: 1, disabled: false });
    const bo: UserView = { id, kind: 'user', name: 'Bo', email: 'bo@example.com', role: 'admin' };
    const person = personOperations(running.services);
    const session = await person.session_create({ title: 'Plans' }, bo);
    expect((await person.session_update({ session: session.id, title: 'Trips' }, bo)).title).toBe('Trips');
    expect(await person.session_delete({ session: session.id }, bo)).toEqual({ deleted: true });
    const reads = adminReadOperations(running.services);
    expect(await reads.budgets_list({}, bo)).toEqual(expect.any(Array));
    expect((await reads.providers_list({}, bo)).map((p) => p.provider)).toEqual(expect.any(Array));
    expect(await reads.actor_settings_list({}, bo)).toMatchObject({ values: [] });
    expect(await reads.mcps_list({}, bo)).toEqual([]);
    expect(await reads.auto_pairs_list({}, bo)).toEqual([]);
    await expect(reads.suggest_decision_get({}, bo)).resolves.toBeDefined();
    expect(await reads.pairings_list({}, bo)).toEqual([]);
    expect(await reads.policies_list({}, bo)).toEqual([]);
    expect(await reads.priority_rules_list({}, bo)).toEqual([]);
    await expect(reads.instances_list({ system: SystemName.parse('nowhere') }, bo)).rejects.toMatchObject({ status: 404 });
    const explore = exploreOperations(running.services);
    expect(await explore.explore_roots({ system: SystemName.parse('fs') }, bo)).toEqual([]);
    // no system serves the URI, so there is nothing to list or read
    const uri = ResourceUri.parse('file:///nowhere/a.md');
    await expect(explore.explore_list({ uri }, bo)).rejects.toThrow();
    await expect(explore.explore_read({ uri, want: [] }, bo)).rejects.toThrow();
  });
});

describe('a chat turn over the real modules', () => {
  it('plans the prompt, calls the model through its role and records the call', async () => {
    const { chat, store } = running.services;
    const owner = mintId('actor');
    await store.table('actors').insert({ id: owner, kind: 'user', name: 'Di', about: '', email: 'di@example.com', role: 'admin', createdAt: 1, disabled: false });
    const session = await chat.sessions.create({ owner });
    provider.script(says('Hello there.'));
    const sent = await chat.turns.send({ session: session.id, author: owner, parts: [{ type: 'text', text: 'hi' }], client: { timeZone: 'UTC', locale: 'en', now: 0 } });
    for (let i = 0; i < 200 && (await store.table('turns').get(sent.turn))?.status === 'running'; i += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect((await store.table('turns').get(sent.turn))?.status).toBe('done');
    expect(provider.requests).toHaveLength(1);
    expect((await store.table('modelCalls').find({ limit: 5 })).items.some((call) => call.session === session.id)).toBe(true);
  });
});

describe('the fns module over the real modules', () => {
  it('searches, pages examples and works out facts of the hub\'s own fns', async () => {
    const { fns, access } = running.services;
    const actor = mintId('actor');
    await running.services.store.table('actors').insert({ id: actor, kind: 'user', name: 'Cy', about: '', email: 'cy@example.com', role: 'admin', createdAt: 1, disabled: false });
    const asker = { actor, access: await access.scope(actor) };
    const found = await fns.search.search({ systems: [SystemName.parse('hub')], limit: 5 }, asker);
    expect(found.items.length).toBeGreaterThan(0);
    const search = hubContract.fns.fns_search.name;
    expect((await fns.examples.page({ fn: search, limit: 2 }, asker)).fn).toBe(search);
    expect((await fns.facts.facts(search)).mode).toBe('read');
    expect((await fns.facts.modes([search])).get(search)).toBe('read');
    expect((await fns.facts.registry([search])).get(search) ?? []).toEqual([]);
    // a system's fns arriving are followed: their facts are worked out as they come
    const notes = system('notes', { description: 'Notes.' }).with({ fns: { jot: fn({ description: 'Jot a note down.', args: g.obj({ text: g.text() }), returns: g.bool() }) } });
    await running.services.catalog.importManifest(await manifestOf(notes, { version: '1' }));
    const jot = QualifiedName.parse('notes/jot');
    for (let i = 0; i < 100 && (await running.services.store.table('fnFacts').get(jot)) === undefined; i += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect((await fns.facts.facts(jot)).mode).toBe('write');
  });

  it('prices an agent that has never run from the models it may use', async () => {
    const helper = system('helper', { description: 'Helps.' }).with({ fns: { plan: agent({ description: 'Plan a trip.', args: g.obj({ city: g.text() }), returns: g.text(), instructions: 'Plan it.', tools: [], maxIterations: 3, model: { model: TEST_MODEL.id } }) } });
    await running.services.catalog.importManifest(await manifestOf(helper, { version: '1' }));
    const facts = await running.services.fns.facts.facts(QualifiedName.parse('helper/plan'));
    expect(facts.cost).toMatchObject({ basis: 'payload', runs: 0 });
    expect(facts.cost.max).toBeGreaterThan(facts.cost.min);
    expect(facts.cost.typical).toBeGreaterThanOrEqual(0);
  });

  it('keeps a browser\'s logs in its person\'s log file, one file a day, adding to it', async () => {
    const actor = mintId('actor');
    await running.services.store.table('actors').insert({ id: actor, kind: 'user', name: 'Ed', about: '', email: 'ed@example.com', role: 'member', createdAt: 1, disabled: false });
    const { clientLogs } = running.services.fns;
    const first = await clientLogs.write(actor, { entries: [{ type: 'log', at: 1, level: 'warn', message: 'slow send' }], page: '/chat' });
    const second = await clientLogs.write(actor, { entries: [{ type: 'traffic', at: 2, method: 'POST', endpoint: 'send', status: 200, duration: 12 }, { type: 'log', at: 3, level: 'error', message: 'lost socket' }] });
    expect(first).toMatchObject({ written: 1 });
    expect(second).toEqual({ uri: first.uri, written: 2 });
    expect(first.uri).toMatch(/^hub:\/\//);
  });
});
