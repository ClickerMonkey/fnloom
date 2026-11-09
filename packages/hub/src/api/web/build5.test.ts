import { ApprovalId, RunId, SessionId, SystemName, TurnId, type Manifest, type Run } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { openScope } from '../../access/index.ts';
import type { SystemConnection } from '../../link/index.ts';
import { linkServer, TestSystem } from '../../execution/testing.ts';
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
  contributes: names.map((name) => ({ registry: 'database/query-visuals', name, label: name })),
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
    const views = await web.client.call('contributions', { registry: 'database/query-visuals' }, as);
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
