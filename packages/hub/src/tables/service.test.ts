import {
  ActorId, HUB_VISUALS, jsonOf, QualifiedName, RunId, SystemName, TurnId,
  type ContributionView, type FnMode, type Json, type Manifest, type ResolvedLimits, type ResultTable, type Run, type RunSettled,
} from '@harness/core';
import { fn, g } from '@harness/sdk';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { testManifest, rig, webRig } from '../api/testing/rig.ts';
import type { RunInput } from '../execution/index.ts';
import { TestCatalog } from '../execution/testing.ts';
import { tablesEnv } from './env.ts';
import type { TableAsker } from './index.ts';
import { HubTables, type PersonTurn } from './service.ts';

const SHOP = SystemName.parse('shop');
const ANN = ActorId.parse('act_ann');
const AGENT = ActorId.parse('act_agent');

/** A table of `n` numbered rows from `from`, with more past it when `more`. */
const numbers = (from: number, n: number, more: boolean): ResultTable => ({
  columns: [{ name: 'n', kind: 'integer', nullable: false }, { name: 'label', kind: 'text', nullable: true }],
  rows: Array.from({ length: n }, (_, i) => [from + i, i === 0 ? 'a, "quoted"' : null]), offset: from, truncated: more, sort: [],
});

/** The shop's fns: a read returning a table, a write, a read giving text, and a task type's methods. */
function shop() {
  const catalog = new TestCatalog();
  catalog.add('shop', 'orders', fn({ description: 'Orders.', args: g.obj({ offset: g.optional(g.num()), limit: g.optional(g.num()) }), returns: g.text(), tags: ['read'] }));
  catalog.add('shop', 'wipe', fn({ description: 'Wipe.', args: g.obj({}), returns: g.text() }));
  catalog.add('shop', 'note', fn({ description: 'A note.', args: g.obj({}), returns: g.text(), tags: ['read'] }));
  catalog.add('shop', 'asks', fn({ description: 'Needs an approval.', args: g.obj({}), returns: g.text(), tags: ['read'] }));
  catalog.add('shop', 'slow', fn({ description: 'Never ends.', args: g.obj({}), returns: g.text(), tags: ['read'] }));
  catalog.add('shop', 'secret', fn({ description: 'Hidden.', args: g.obj({}), returns: g.text() }));
  catalog.add('shop', 'Task.close', fn({ description: 'Close a task.', args: g.obj({ self: g.text(), reason: g.text() }), returns: g.text() }));
  catalog.add('shop', 'Task.view', fn({ description: 'View a task.', args: g.obj({ self: g.text() }), returns: g.text(), tags: ['read'] }));
  return catalog;
}

const MODES: Readonly<Record<string, FnMode>> = { 'shop/orders': 'read', 'shop/note': 'read', 'shop/asks': 'read', 'shop/slow': 'read', 'shop/wipe': 'write', 'shop/Task.close': 'write', 'shop/Task.view': 'read' };

/** A manifest of the shop with a task type whose methods are close and view. */
const shopManifest: Manifest = testManifest(SHOP, {
  types: [{ name: 'Task', description: 'A task.', def: { name: 'obj', props: {} }, display: { label: 'Task' }, methods: ['close', 'view'] }],
});

/** The service over fakes; `started` records every run it starts, `answer` gives each its result, `cancelled` each cancel. shop/asks waits for an approval and shop/slow never ends. */
function service(answer: (input: RunInput) => Json = () => jsonOf(numbers(0, 3, false)), contributions: ContributionView[] = []) {
  const catalog = shop();
  const started: RunInput[] = [];
  const finished: boolean[] = [];
  const cancelled: RunId[] = [];
  const held = new Map<RunId, Run>();
  const hubManifest = testManifest(SystemName.parse('hub'), { contributes: [{ registry: HUB_VISUALS, name: 'table', label: 'Table' }, { registry: 'hub/other', name: 'x', label: 'X' }] });
  const tables = new HubTables({
    catalog: () => ({ fn: (name) => catalog.fn(name), manifest: (system) => Promise.resolve(system === 'hub' ? hubManifest : system === SHOP ? shopManifest : undefined) }),
    runs: () => ({
      start: (input) => {
        started.push(input);
        const run = RunId.parse(`run_${String(started.length)}`);
        if (input.fn === 'shop/asks') {
          held.set(run, {
            id: run, fn: input.fn, fnVersion: 'v1', kind: 'native', system: SHOP, root: run, turn: input.turn, key: input.key, actor: input.actor, caller: input.caller, args: input.args,
            status: 'awaiting-approval', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0, priority: input.priority, background: false, attempt: 1, errors: [], stateChanges: [], createdAt: 0,
          });
        }
        if (input.fn === 'shop/asks' || input.fn === 'shop/slow') return Promise.resolve({ run, settled: new Promise<RunSettled>(() => undefined) });
        const settled: RunSettled = input.fn === 'shop/note' ? { status: 'done', result: 'just text' } : { status: 'done', result: answer(input) };
        return Promise.resolve({ run, settled: Promise.resolve(settled) });
      },
      get: (run) => Promise.resolve(held.get(run)),
      cancel: (run) => { cancelled.push(run); return Promise.resolve({ accepted: true }); },
    }),
    facts: () => ({ modes: (names) => Promise.resolve(new Map(names.map((name) => [name, MODES[name] ?? 'write']))) }),
    access: (actor) => Promise.resolve({ ...openScope(actor), seesFn: (record) => record.name !== 'shop/secret', mayUse: (record) => record.name !== 'shop/Task.view' || actor === ANN }),
    contributions: () => Promise.resolve(contributions),
    turn: (): Promise<PersonTurn> => Promise.resolve({ id: TurnId.parse('trn_export'), priority: 'interactive', finish: (ok) => { finished.push(ok); return Promise.resolve(); } }),
    settings: { ...tablesEnv.parse(), HARNESS_EXPORT_PAGE: 2, HARNESS_EXPORT_MAX_ROWS: 5, HARNESS_QUIET_READ_TIMEOUT: 1_000 },
  });
  return { tables, started, finished, cancelled };
}

const asker: TableAsker = {
  id: RunId.parse('run_parent'), turn: TurnId.parse('trn_1'), caller: AGENT,
  user: { id: ANN, name: 'Ann', email: 'ann@example.com', role: 'member', groups: [], timeZone: 'UTC', locale: 'en' },
};

/** Every line an export writes. */
async function drain(lines: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const line of lines) { out += line; }
  return out;
}

describe('hub tables', () => {
  it('reads a read fn as a table in a child run of the caller, and refuses a write or a fn that gives no table', async () => {
    const { tables, started } = service();
    const table = await tables.read({ fn: QualifiedName.parse('shop/orders'), args: { limit: 3 } }, asker);
    expect(table.rows).toHaveLength(3);
    expect(started[0]).toMatchObject({ fn: 'shop/orders', args: { limit: 3 }, parent: 'run_parent', turn: 'trn_1', actor: ANN, caller: AGENT, background: false });
    await expect(tables.read({ fn: QualifiedName.parse('shop/wipe'), args: {} }, asker)).rejects.toMatchObject({ error: { code: 'not-a-read' } });
    await expect(tables.read({ fn: QualifiedName.parse('shop/note'), args: {} }, asker)).rejects.toMatchObject({ error: { code: 'not-a-table' } });
    expect(started).toHaveLength(2);
    // a fn the person may not see is missing, never "writes"
    await expect(tables.read({ fn: QualifiedName.parse('shop/secret'), args: {} }, asker)).rejects.toMatchObject({ error: { code: 'no-fn', message: 'there is no fn shop/secret' } });
  });

  it('refuses a quiet read that waits for approval, and stops one when the request goes away or runs too long', async () => {
    const { tables, cancelled, finished } = service();
    let said = '';
    /** The refusal a call ends in; `said` keeps its words. */
    const refusal = async (call: Promise<unknown>): Promise<unknown> => {
      try { await call; } catch (error) { said = error instanceof Error ? error.message : ''; return error; }
      throw new Error('it was not refused');
    };
    const user = { kind: 'user' as const, id: ANN, name: 'Ann', email: 'ann@example.com', role: 'member' as const };
    expect(await refusal(tables.readAs({ fn: QualifiedName.parse('shop/asks'), args: {} }, user))).toMatchObject({ status: 400, code: 'READ_FAILED' });
    expect(said).toContain('needs an approval');
    expect(cancelled).toEqual(['run_1']);
    const gone = new AbortController();
    const reading = tables.readAs({ fn: QualifiedName.parse('shop/slow'), args: {} }, user, gone.signal);
    gone.abort();
    await refusal(reading);
    expect(said).toContain('the request went away');
    await refusal(tables.readAs({ fn: QualifiedName.parse('shop/slow'), args: {} }, user));
    expect(said).toContain('took too long');
    expect(cancelled).toEqual(['run_1', 'run_2', 'run_3']);
    expect(finished).toEqual([false, false, false]);
    await expect(tables.export({ fn: QualifiedName.parse('shop/asks'), args: '{}', offset: 'offset', limit: 'limit', format: 'csv' }, user)).rejects.toMatchObject({ status: 400, code: 'NOT_EXPORTABLE' });
    expect(cancelled).toHaveLength(4);
  });

  it('lists the hub\'s own visuals first, then other systems\', and derives row actions as the person may use them', async () => {
    const charts: ContributionView = { registry: HUB_VISUALS, name: 'pie', label: 'Pie', system: SystemName.parse('charts') };
    const { tables } = service(undefined, [charts, { registry: HUB_VISUALS, name: 'table', label: 'Table', system: SystemName.parse('hub') }]);
    expect((await tables.visuals(ANN)).map((v) => `${v.system}:${v.name}`)).toEqual(['hub:table', 'charts:pie']);

    const all = await tables.rowActions({ types: [QualifiedName.parse('shop/Task')] }, ANN);
    expect(all.map((a) => [a.fn, a.label, a.confirm, a.then])).toEqual([['shop/Task.close', 'Close', true, 'refresh'], ['shop/Task.view', 'View', false, 'status']]);
    expect(all[0]?.form?.props).toHaveProperty('reason');
    // another person may not use one of them; a widget narrows and relabels, and may add any fn
    expect((await tables.rowActions({ types: [QualifiedName.parse('shop/Task')] }, ActorId.parse('act_ben'))).map((a) => a.fn)).toEqual(['shop/Task.close']);
    const narrowed = await tables.rowActions({ types: [QualifiedName.parse('shop/Task')], narrow: [{ fn: QualifiedName.parse('shop/orders'), label: 'Orders', bind: { limit: 'n' } }] }, ANN);
    expect(narrowed).toEqual([expect.objectContaining({ fn: 'shop/orders', label: 'Orders', mode: 'read', confirm: false, bind: { limit: 'n' } })]);
  });

  it('exports a read fn page by page as CSV, cut at the ceiling with a final line, in one turn', async () => {
    const { tables, started, finished } = service((input) => {
      const args = z.object({ offset: z.number(), limit: z.number() }).parse(input.args);
      return jsonOf(numbers(args.offset, args.limit, true));
    });
    const user = { kind: 'user' as const, id: ANN, name: 'Ann', email: 'ann@example.com', role: 'member' as const };
    const { name, lines } = await tables.export({ fn: QualifiedName.parse('shop/orders'), args: '{}', offset: 'offset', limit: 'limit', format: 'csv' }, user);
    expect(name).toBe('orders.csv');
    expect(await drain(lines)).toBe('n,label\r\n0,"a, ""quoted"""\r\n1,\r\n2,"a, ""quoted"""\r\n3,\r\n4,"a, ""quoted"""\r\n# Cut at 5 rows: more rows were left out.\r\n');
    expect(started.map((s) => [s.key, s.args, s.turn, s.actor])).toEqual([
      ['export:0', { offset: 0, limit: 2 }, 'trn_export', ANN], ['export:2', { offset: 2, limit: 2 }, 'trn_export', ANN], ['export:4', { offset: 4, limit: 1 }, 'trn_export', ANN],
    ]);
    expect(finished).toEqual([true]);
    await expect(tables.export({ fn: QualifiedName.parse('shop/wipe'), args: '{}', offset: 'offset', limit: 'limit', format: 'csv' }, user)).rejects.toMatchObject({ status: 400, code: 'NOT_EXPORTABLE' });
    await expect(tables.export({ fn: QualifiedName.parse('shop/orders'), args: '[1]', offset: 'offset', limit: 'limit', format: 'csv' }, user)).rejects.toMatchObject({ status: 400, code: 'BAD_ARGS' });
  });

  it('serves the export as a download over GET /api/export, and row actions to the signed-in person', async () => {
    const catalog = shop();
    const limits: ResolvedLimits = { priority: 'normal', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 1_000 }, budgets: [] };
    const r = await rig({
      catalog: { fn: (name) => catalog.fn(name), manifest: (system) => Promise.resolve(system === SHOP ? shopManifest : undefined) },
      fns: { facts: { modes: (names) => Promise.resolve(new Map(names.map((name) => [name, MODES[name] ?? 'write']))) } },
      execution: {
        limits: { resolve: () => Promise.resolve(limits) },
        runs: {
          start: () => Promise.resolve({ run: RunId.parse('run_x'), settled: Promise.resolve<RunSettled>({ status: 'done', result: jsonOf(numbers(0, 2, false)) }) }),
          get: () => Promise.resolve(undefined),
        },
      },
      access: { scope: (actor) => Promise.resolve(openScope(actor)) },
    });
    const web = await webRig(r);
    const as = web.as(await web.admin());
    const query = new URLSearchParams({ fn: 'shop/orders', args: '{}', offset: 'offset', limit: 'limit', format: 'csv' });
    const res = await web.app.fetch(new Request(`http://hub/export?${query.toString()}`, as));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('orders.csv');
    expect(await res.text()).toBe('n,label\r\n0,"a, ""quoted"""\r\n1,\r\n');
    const turns = await r.store.table('turns').find({ limit: 5 });
    expect(turns.items.map((t) => t.status)).toEqual(['done']);
    const refused = await web.app.fetch(new Request(`http://hub/export?${new URLSearchParams({ fn: 'shop/wipe', args: '{}', offset: 'o', limit: 'l', format: 'csv' }).toString()}`, as));
    expect(refused.status).toBe(400);
    expect(await web.client.call('rowActions', { types: ['shop/Task'] }, as)).toHaveLength(2);
  });
});
