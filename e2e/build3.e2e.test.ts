/**
 * Build 3 on the real stack: list queries with filters and sort (two lists, and the `hub/query` fn the chat LLM calls),
 * a turn that records the suggestions it did not use with their reasons (by score, then by the decision model),
 * controlling one run of a turn by id, and auto pair: an fs instance paired with a token that allows it re-pairs
 * with its secret after its key is deleted, and the secret rotates.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutoPairGrant, InstanceName, Json, ListQuery, QualifiedName, SystemName, type ChatMessage, type RunId, type SessionId } from '@harness/core';
import { SYSTEM_ENV } from '@harness/sdk/server';
import { liveModels } from '@harness/sdk/server/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { halt, ROOT, runComponent, type Child } from '../scripts/stack.ts';
import { admin, ask as askAgent, clientInfo, invoke, runsOf, SessionWatch, settings, settle } from './kit.ts';

const TURN = settings.HARNESS_E2E_TURN_TIMEOUT;
const FS = SystemName.parse('fs');
const BENCH = InstanceName.parse('bench');
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const state = resolve(ROOT, settings.HARNESS_E2E_DATA, 'bench-state');

let me: SignedIn;
let watch: SessionWatch;
let session: SessionId;
let bench: Child | undefined;

const ask = (text: string) => askAgent(me, watch, text, TURN);

/** The user message of a turn, as stored. */
async function userMessageOf(turn: string): Promise<ChatMessage | undefined> {
  const page = await me.hub.call('messages', { session, limit: 50 });
  return page.items.find((message) => message.turn === turn && message.role === 'user');
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e build 3' })).id;
  watch = new SessionWatch(me, session);
});

afterAll(async () => {
  watch.stop();
  if (bench !== undefined) { await halt(bench, 10_000); }
  await me.hub.call('setSuggestDecision', { by: 'none' }).catch(() => undefined);
  await me.hub.call('removeInstance', { system: FS, instance: BENCH }).catch(() => undefined);
  me.close();
});

describe('list queries', () => {
  it('filter and sort the fns list on the hub', async () => {
    const page = await me.hub.call('fns', { filters: [{ field: 'system', op: 'is', value: 'fs' }], sort: [{ field: 'name', dir: 'desc' }] });
    const names = page.items.map((row) => row.name);
    expect(names.length).toBeGreaterThan(3);
    expect(names.every((name) => name.startsWith('fs/'))).toBe(true);
    // names sort without regard to case
    expect(names).toEqual([...names].sort((x, y) => y.toLowerCase().localeCompare(x.toLowerCase())));
    const viaQuery = await me.hub.call('query', { list: 'fns', query: { filters: [{ field: 'system', op: 'is', value: 'fs' }], sort: [{ field: 'name', dir: 'desc' }] } });
    expect(viaQuery.sort).toEqual([{ field: 'name', dir: 'desc' }]);
    expect(viaQuery.items).toHaveLength(names.length);
  });

  it('filter and sort the runs list, and the hub/query fn answers the same query', async () => {
    await invoke(me, session, QualifiedName.parse('fs/list'), { path: '.' });
    const query = ListQuery.parse({ filters: [{ field: 'fn', op: 'is', value: 'fs/list' }, { field: 'cost', op: 'gte', value: 0 }], sort: [{ field: 'createdAt', dir: 'asc' }] });
    const runs = await me.hub.call('runs', { query });
    expect(runs.items.length).toBeGreaterThan(0);
    expect(runs.items.every((run) => run.fn === 'fs/list')).toBe(true);
    const times = runs.items.map((run) => run.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const viaFn = await invoke(me, session, QualifiedName.parse('hub/query'), { list: 'runs', query: Json.parse(query) });
    expect(viaFn.status).toBe('done');
    expect(JSON.stringify(viaFn.outcome)).toContain(runs.items[0]?.id ?? 'none');
  });

  it('refuse a filter on a field the list does not have', async () => {
    await expect(me.hub.call('query', { list: 'runs', query: { filters: [{ field: 'nope', op: 'empty' }] } })).rejects.toMatchObject({ status: 422 });
  });
});

describe('suggestions and the decision model', () => {
  it('a turn records what it suggested and what it did not use, with a reason, and the LLM can call hub/query', async () => {
    const { turn, answer } = await ask('Use the hub/query tool (load it with hub/load_fns if needed) to list the 3 newest runs of the list "runs", then tell me their fn names.');
    expect(answer.status).toBe('done');
    const sent = await userMessageOf(turn);
    expect(sent?.suggestions?.by).toBe('score');
    const reasons = sent?.suggestions?.items.flatMap((item) => (item.used ? [] : [item.reason])) ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason.length > 0)).toBe(true);
    const tree = await me.hub.call('tree', { turn });
    expect(runsOf(tree).map((node) => node.run.fn)).toContain('hub/query');
  });

  it('with an LLM picking, the model picks and the record links its call', async () => {
    const model = liveModels()[0];
    expect(model).toBeDefined();
    if (model === undefined) { return; }
    await me.hub.call('setSuggestDecision', { by: 'llm', model: { model: { model } }, messages: 3, candidates: 12, cap: 4, floor: 0.05 });
    const preview = await me.hub.call('previewSuggestions', { session, text: 'Read the README file and summarise it.' });
    expect(preview.by).toBe('decision');
    expect(preview.items.length).toBeGreaterThan(0);
    const { turn } = await ask('Read README.md with fs/read and give me its first heading only.');
    const record = (await userMessageOf(turn))?.suggestions;
    expect(record?.by).toBe('decision');
    expect((record?.items ?? []).flatMap((item) => (item.used ? [] : [item.reason])).every((reason) => reason.length > 0)).toBe(true);
    // the model answered (picked or declined) or failed and the score decided: either way it is recorded
    if (!(record?.items.some((item) => !item.used && item.reason === 'failed') ?? false)) { expect(record?.calls?.length).toBeGreaterThan(0); }
  });
});

describe('controlling one run', () => {
  // no fn of the stock systems declares a resume type (agent runs don't pause either), so pausing is refused here;
  // the hub's per-run pause and resume are covered by chat/sessions.test.ts with a pausable fake
  it('lists the runs of a turn with what each allows, refuses to pause one that cannot, and stops one picked by id', async () => {
    const seen = new Set(watch.of('controls'));
    const sent = await me.hub.call('send', { session, parts: [{ type: 'text', text: 'Write a 400-word story about a lighthouse keeper. Do not use any tools.' }], client: clientInfo() });
    const controls = await watch.next('controls', (event) => !seen.has(event) && (event.controls.runs ?? []).some((run) => run.cancel), TURN);
    const target = (controls.controls.runs ?? []).find((run) => run.cancel);
    expect(target).toBeDefined();
    if (target === undefined) { return; }
    const run: RunId = target.run;
    expect(target.pause).toBe(false);
    await me.hub.call('control', { session, action: 'pause', runs: [run] });
    expect((await me.hub.call('run', { run })).status).not.toBe('paused');
    await me.hub.call('control', { session, action: 'cancel', runs: [run] });
    await waitFor('the run stopped', async () => ((await me.hub.call('run', { run })).status === 'cancelled' ? true : undefined), { timeout: 60_000, every: 300 });
    expect((await me.hub.call('tree', { turn: sent.turn })).run.status).not.toBe('running');
  });
});

describe('auto pair', () => {
  const start = (env: Readonly<Record<string, string>>): Child => runComponent('fs', [TSX, join(ROOT, 'systems', 'fs', 'server', 'main.ts')], {
    cwd: ROOT, output: () => undefined,
    env: { [SYSTEM_ENV.hub]: `${inject('e2eHub').url.replace(/^http/, 'ws')}/link`, [SYSTEM_ENV.state]: state, [SYSTEM_ENV.instance]: BENCH, HARNESS_PAIRING_QR: 'never', ...env },
  });
  const grantFile = join(state, 'auto-pair.json');
  const grant = () => AutoPairGrant.parse(JSON.parse(readFileSync(grantFile, 'utf8')));

  it('pairs with a token that allows auto pair, and the system keeps its secret', async () => {
    rmSync(state, { recursive: true, force: true });
    const { token } = await me.hub.call('createPairingToken', { name: FS, expiresIn: 600_000, autoPair: {} });
    bench = start({ [SYSTEM_ENV.pairingToken]: token });
    await waitFor('the auto-pair secret saved', () => Promise.resolve(existsSync(grantFile) ? true : undefined), { timeout: 120_000, every: 300 });
    const [secret] = (await me.hub.call('autoPairs', { system: FS })).filter((row) => row.instance === BENCH && row.revokedAt === undefined);
    expect(secret?.expiresAt).toBeDefined();
    // no expiry picked: the hub's default, 90 days
    expect((secret?.expiresAt ?? 0) - (secret?.createdAt ?? 0)).toBe(90 * 24 * 60 * 60 * 1000);
  }, 150_000);

  it('re-pairs with the secret after its key is deleted, and the secret rotates', async () => {
    const before = grant();
    if (bench !== undefined) { await halt(bench, 10_000); }
    rmSync(join(state, 'key.json'), { force: true });
    bench = start({});
    const used = await waitFor('the secret used', async () => {
      const [row] = (await me.hub.call('autoPairs', { system: FS })).filter((r) => r.id === before.id && r.uses > 0);
      return row;
    }, { timeout: 120_000, every: 500 });
    expect(used.uses).toBe(1);
    await waitFor('the rotated secret saved', () => Promise.resolve(existsSync(grantFile) && grant().secret !== before.secret ? true : undefined), { timeout: 30_000, every: 300 });
    expect((await me.hub.call('pairings', { status: 'pending' })).filter((p) => p.instance === BENCH)).toEqual([]);
  }, 150_000);
});
