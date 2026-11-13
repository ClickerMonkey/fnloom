import { ApprovalId, ResourceUri, RunId, type FnFacts, SessionId, SystemName, TurnId, type Manifest, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope } from '../../access/index.ts';
import type { SystemConnection } from '../../link/index.ts';
import { linkServer, TestCatalog, TestSystem } from '../../execution/testing.ts';
import { fn, g } from '@harness/sdk';
import { rig, webRig } from '../testing/rig.ts';

const DB = SystemName.parse('database');
const CHARTS = SystemName.parse('charts');
const HIDDEN = SystemName.parse('hidden');
const RUN = RunId.parse('run_1');

/** A connection of a system over an in-process link (the contributions read looks only at which systems are connected). */
const hubSide = linkServer();
const connected = (system: SystemName): SystemConnection => new TestSystem(system, hubSide).connection(hubSide);

/** A manifest that only contributes visuals. */
const contributing = (system: SystemName, names: readonly string[]): Manifest => ({
  name: system, description: '', version: '1.0.0', hash: 'h', config: { name: 'object', props: {} }, resources: false, events: [], requires: [],
  types: [], settings: [], attachments: [], kinds: [], fns: [], context: [], hooks: [], mentions: [], embedders: [], sectioners: [], actions: [],
  contributes: names.map((name) => ({ registry: 'hub/visuals', name, label: name })),
});

const run: Run = {
  id: RUN, fn: 'database/main.add_order', fnVersion: 'v1', kind: 'database/query', system: DB, root: RUN, turn: TurnId.parse('trn_1'), session: SessionId.parse('ses_1'),
  key: 'k', actor: 'act_x', caller: 'act_x', args: {}, status: 'awaiting-approval', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0,
  priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
};

describe('build 5 endpoints', () => {
  it('list the contributions to a registry from connected systems the person may see, and the approvals of runs with previews', async () => {
    const r = await rig({
      link: { connections: { connected: () => [connected(DB), connected(CHARTS), connected(HIDDEN), connected(DB)] } },
      catalog: { manifest: (system) => Promise.resolve(contributing(system, system === DB ? ['table', 'bar'] : ['pie'])) },
      access: { scope: (actor) => Promise.resolve({ ...openScope(actor), seesSystem: (system) => system !== HIDDEN }) },
      execution: { runs: { get: (id) => Promise.resolve(id === RUN ? run : undefined) } },
    });
    const web = await webRig(r);
    const as = web.as(await web.admin());
    const views = await web.client.call('contributions', { registry: 'hub/visuals' }, as);
    expect(views.map((v) => `${v.system}:${v.name}`)).toEqual(['charts:pie', 'database:bar', 'database:table']);
    expect(await web.client.call('contributions', { registry: 'other/thing' }, as)).toEqual([]);

    const preview = { title: 'Insert 1 row', parts: [{ type: 'text' as const, text: 'Adds an order.' }], irreversible: false };
    await r.store.table('approvals').insert({
      id: ApprovalId.parse('apr_1'), run: RUN, fn: run.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: 0, preview, proposed: true,
    });
    const approvals = await web.client.call('approvals', { runs: [RUN, RunId.parse('run_gone')] }, as);
    expect(approvals).toEqual([expect.objectContaining({ id: 'apr_1', preview, proposed: true })]);
  });
});

/** A fn record of the books system. */
const books = new TestCatalog();
const catalogFn = (name: string) => books.add('books', name.slice('books/'.length), fn({ description: name, args: g.obj({}), returns: g.text(), tags: ['read'] }));

describe('fns endpoints (build 5 feedback)', () => {
  it('search, page examples, read facts of fns the person sees, take browser logs, and set the auto classifier', async () => {
    const searched: unknown[] = [];
    const logged: unknown[] = [];
    const facts: FnFacts = { fn: 'books/overdue', kind: 'native', mode: 'read', reads: [], writes: [], uses: [], free: true, registry: [], cost: { min: 0, typical: 0, max: 0, basis: 'free', runs: 0 }, longRunning: false };
    const r = await rig({
      catalog: { fn: (name) => Promise.resolve(name === 'books/overdue' || name === 'books/secret' ? catalogFn(name) : undefined) },
      access: { scope: (actor) => Promise.resolve({ ...openScope(actor), seesFn: (f) => f.name !== 'books/secret' }) },
      fns: {
        search: { search: (query, asker) => { searched.push({ query, actor: asker.actor }); return Promise.resolve({ items: [] }); } },
        examples: { page: (query) => Promise.resolve({ fn: query.fn, items: [], total: 0 }) },
        facts: { facts: () => Promise.resolve(facts) },
        clientLogs: { write: (user, batch) => { logged.push({ user, batch }); return Promise.resolve({ uri: ResourceUri.parse('hub://resources/logs/x/a.jsonl'), written: batch.entries.length }); } },
        classifier: {
          setting: () => Promise.resolve({ value: { messages: 4 } }),
          set: (value, by) => Promise.resolve({ value, setBy: by, updatedAt: 1 }),
        },
      },
    });
    const web = await webRig(r);
    const as = web.as(await web.admin());
    expect(await web.client.call('searchFns', { text: 'overdue', kinds: ['database/query'], order: 'score' }, as)).toEqual({ items: [] });
    const anyText: unknown = expect.any(String);
    expect(searched).toEqual([{ query: { text: 'overdue', kinds: ['database/query'], order: 'score' }, actor: anyText }]);
    expect(await web.client.call('fnExamples', { fn: 'books/overdue', query: 'late' }, as)).toEqual({ fn: 'books/overdue', items: [], total: 0 });
    expect(await web.client.call('fnFacts', { fn: 'books/overdue' }, as)).toEqual(facts);
    await expect(web.client.call('fnFacts', { fn: 'books/secret' }, as)).rejects.toThrow(/no fn/);
    const batch = { entries: [{ type: 'traffic' as const, at: 1, method: 'POST', endpoint: 'send', status: 200, duration: 12 }] };
    expect(await web.client.call('clientLogs', batch, as)).toEqual({ uri: 'hub://resources/logs/x/a.jsonl', written: 1 });
    expect(logged).toEqual([{ user: anyText, batch }]);
    expect(await web.client.call('setAutoClassifier', { model: { model: { model: 'cheap' } }, messages: 2 }, as)).toMatchObject({ value: { messages: 2 }, updatedAt: 1 });
    expect(await web.client.call('autoClassifier', {}, as)).toEqual({ value: { messages: 4 } });
  });
});
