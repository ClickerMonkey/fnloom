import { ADMIN_READ_ENDPOINTS, HUB_EXPLORE_ENDPOINTS, HUB_PERSON_ENDPOINTS, fn, hub, manifestOf } from '@harness/sdk';
import { QualifiedName, type Json } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInput } from '../execution/index.ts';
import { ALICE, executionRig, SESSION, type ExecutionRig } from '../execution/testing.ts';
import type { AdminReadOperations, ExploreOperations, PersonOperations } from '../api/person-ops.ts';
import { registerPersonFns } from './person-fns.ts';

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** An operation that says it was reached, with the person and args it was given, by refusing with its own name. */
const reached = (seen: Array<{ name: string; data: unknown; user: string }>) => (name: string) => (data: unknown, user: { id: string }): Promise<never> => {
  seen.push({ name, data, user: user.id });
  return Promise.reject(new Error(`reached ${name}`));
};

describe('the person fns', () => {
  it('runs each one\'s operation with its checked args, as the run\'s person', async () => {
    const r = await executionRig();
    rig = r;
    const names = [...Object.keys(HUB_PERSON_ENDPOINTS), ...Object.keys(HUB_EXPLORE_ENDPOINTS), ...Object.keys(ADMIN_READ_ENDPOINTS)];
    const manifest = await manifestOf(hub, { version: '1' });
    for (const name of names) {
      const ref = Object.values(hub.fns).find((candidate) => candidate.name === `hub/${name}`);
      if (ref === undefined) throw new Error(`the hub contract has no ${name}`);
      r.catalog.add('hub', name, fn({ description: name, args: ref.args, returns: ref.returns, tags: ['read'] }));
    }
    const seen: Array<{ name: string; data: unknown; user: string }> = [];
    const op = reached(seen);
    // written out, so the types say every operation is here
    const person: PersonOperations = {
      session_create: op('session_create'),
      session_update: op('session_update'),
      session_delete: op('session_delete'),
      run_background: op('run_background'),
      turn_undo: op('turn_undo'),
      memory_update: op('memory_update'),
      context_link: op('context_link'),
      context_unlink: op('context_unlink'),
      access_set: op('access_set'),
      connection_update: op('connection_update'),
      connection_disconnect: op('connection_disconnect'),
    };
    const explore: ExploreOperations = {
      explore_roots: op('explore_roots'),
      explore_list: op('explore_list'),
      explore_read: op('explore_read'),
    };
    const adminReads: AdminReadOperations = {
      budgets_list: op('budgets_list'),
      policies_list: op('policies_list'),
      priority_rules_list: op('priority_rules_list'),
      providers_list: op('providers_list'),
      actors_list: op('actors_list'),
      actor_settings_list: op('actor_settings_list'),
      mcps_list: op('mcps_list'),
      mcp_sessions_list: op('mcp_sessions_list'),
      pairings_list: op('pairings_list'),
      auto_pairs_list: op('auto_pairs_list'),
      instances_list: op('instances_list'),
      suggest_decision_get: op('suggest_decision_get'),
    };
    registerPersonFns(r.module.hubFns, { person: () => person, explore: () => explore, adminReads: () => adminReads });
    await r.session();
    await r.module.start();
    const turn = await r.turn({ session: SESSION, text: 'hello' });
    for (const name of names) {
      const args: Json = manifest.fns.find((decl) => decl.name === name)?.examples?.[0]?.args ?? {};
      const input: RunInput = { fn: QualifiedName.parse(`hub/${name}`), args, turn: turn.id, session: SESSION, key: name, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
      expect(await (await r.module.runs.start(input)).settled, name).toMatchObject({ status: 'failed', error: { message: `reached ${name}` } });
    }
    expect(seen.map((call) => call.name)).toEqual(names);
    expect(seen.every((call) => call.user === ALICE)).toBe(true);
  });
});
