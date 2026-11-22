/**
 * The admin pages' reads, shared by their web handlers and hub fns: each refuses anyone but an admin and answers an
 * admin from the hub's records.
 */
import { ActorId, HubMcpId, SystemName, type UserView } from '@harness/core';
import type { AdminReadFnName } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { adminReadOperations } from './person-ops.ts';
import { rig } from './testing/rig.ts';

const admin: UserView = { id: ActorId.parse('act_admin'), kind: 'user', name: 'Admin', email: 'admin@example.com', role: 'admin' };
const member: UserView = { ...admin, id: ActorId.parse('act_member'), name: 'Member', email: 'member@example.com', role: 'member' };

describe('adminReadOperations', () => {
  it('refuses every read to anyone but an admin', async () => {
    const { hub } = await rig();
    const ops = adminReadOperations(hub);
    const fs = SystemName.parse('fs');
    const reads: Record<AdminReadFnName, () => Promise<unknown>> = {
      budgets_list: () => ops.budgets_list({}, member),
      policies_list: () => ops.policies_list({}, member),
      priority_rules_list: () => ops.priority_rules_list({}, member),
      providers_list: () => ops.providers_list({}, member),
      actors_list: () => ops.actors_list({}, member),
      actor_settings_list: () => ops.actor_settings_list({}, member),
      mcps_list: () => ops.mcps_list({}, member),
      mcp_sessions_list: () => ops.mcp_sessions_list({ mcp: HubMcpId.parse('mcp_1') }, member),
      pairings_list: () => ops.pairings_list({}, member),
      auto_pairs_list: () => ops.auto_pairs_list({ system: fs }, member),
      instances_list: () => ops.instances_list({ system: fs }, member),
      suggest_decision_get: () => ops.suggest_decision_get({}, member),
      search_decision_get: () => ops.search_decision_get({}, member),
    };
    for (const [name, read] of Object.entries(reads)) {
      await expect(Promise.resolve().then(read), name).rejects.toMatchObject({ status: 403 });
    }
  });

  it('answers an admin from the hub records', async () => {
    const { hub, store } = await rig();
    await store.table('actors').put({ ...admin, about: '', disabled: false, createdAt: 1 });
    const ops = adminReadOperations(hub);
    expect(await ops.policies_list({}, admin)).toEqual([]);
    expect(await ops.priority_rules_list({}, admin)).toEqual([]);
    expect(await ops.pairings_list({}, admin)).toEqual([]);
    expect((await ops.actors_list({ kind: 'user' }, admin)).map((actor) => actor.id)).toEqual([admin.id]);
    expect(await ops.actors_list({ kind: 'system' }, admin)).toEqual([]);
  });
});

