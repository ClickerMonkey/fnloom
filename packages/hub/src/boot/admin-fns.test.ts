import { ADMIN_ENDPOINTS, fn, hub, manifestOf, type FnRef } from '@harness/sdk';
import { QualifiedName, READ_TAG, type Json, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminOperations } from '../api/admin-ops.ts';
import { RunRefused } from '../execution/errors.ts';
import type { RunInput } from '../execution/index.ts';
import { ALICE, ALICE_INFO, executionRig, SESSION, type ExecutionRig } from '../execution/testing.ts';
import { ADMIN_FN_NAMES, registerAdminFns } from './admin-fns.ts';

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** An operation a test doesn't use. */
const unused = (): Promise<never> => Promise.reject(new Error('not used in this test'));

/** Admin operations that record what they were asked, answering set_budget and configure_provider. */
function recordingOps(asked: Array<{ op: string; data: unknown; by: string }>): AdminOperations {
  return {
    configure_provider: (data, by) => { asked.push({ op: 'configure_provider', data, by }); return Promise.resolve({ models: 3 }); },
    set_budget: (data, by) => { asked.push({ op: 'set_budget', data, by }); return Promise.resolve({ id: 'bgt_1' }); },
    set_model_category: unused, set_priority: unused, set_policy: unused, set_actor_setting: unused, add_user: unused, add_group: unused,
    remove_rule: unused, approve_pairing: unused, create_pairing_token: unused, configure_system: unused, enable_system: unused, remove_system: unused,
    install_system: unused, start_system: unused, stop_system: unused, upgrade_system: unused,
  };
}

/** Put an admin fn in the rig's catalog with the contract's args and result (tagged read here, so no approval waits). */
function addAdminFn<A, R>(r: ExecutionRig, ref: FnRef<QualifiedName, A, R>): void {
  r.catalog.add('hub', ref.name.slice('hub/'.length), fn({ description: ref.name, args: ref.args, returns: ref.returns, tags: [READ_TAG] }));
}

async function started() {
  const r = await executionRig();
  rig = r;
  addAdminFn(r, hub.fns.set_budget);
  addAdminFn(r, hub.fns.configure_provider);
  const asked: Array<{ op: string; data: unknown; by: string }> = [];
  registerAdminFns(r.module.hubFns, () => recordingOps(asked));
  await r.session();
  await r.module.start();
  return { r, asked, turn: await r.turn({ session: SESSION, text: 'set a budget' }) };
}

async function call(r: ExecutionRig, turn: Turn, name: string, args: Json) {
  const input: RunInput = { fn: QualifiedName.parse(`hub/${name}`), args, turn: turn.id, session: SESSION, key: name, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [] };
  return (await r.module.runs.start(input)).settled;
}

describe('admin fns', () => {
  it('offers every admin endpoint as a hub fn, none tagged read, each implemented', async () => {
    const r = await executionRig();
    rig = r;
    registerAdminFns(r.module.hubFns, () => recordingOps([]));
    const manifest = await manifestOf(hub, { version: 'test' });
    expect(ADMIN_FN_NAMES).toEqual(Object.keys(ADMIN_ENDPOINTS));
    for (const name of ADMIN_FN_NAMES) {
      const decl = manifest.fns.find((f) => f.name === name);
      expect(decl, name).toBeDefined();
      expect(decl?.tags, name).not.toContain(READ_TAG);
      expect(r.module.hubFns.has(hub.fns[name].name), name).toBe(true);
    }
  });

  it('runs the operation with the endpoint body, for the admin whose turn it is', async () => {
    const { r, asked, turn } = await started();
    const budget = { target: { scope: 'hub' }, period: 'per-turn', maxCost: 2, onLimit: 'refuse' };
    expect(await call(r, turn, 'set_budget', budget)).toEqual({ status: 'done', result: { id: 'bgt_1' } });
    expect(asked).toEqual([{ op: 'set_budget', data: budget, by: ALICE }]);
  });

  it('takes a body that is a union of shapes as its input field', async () => {
    const { r, asked, turn } = await started();
    expect(await call(r, turn, 'configure_provider', { input: { provider: 'openrouter', apiKey: 'sk-or-1' } })).toEqual({ status: 'done', result: { models: 3 } });
    expect(asked).toEqual([{ op: 'configure_provider', data: { provider: 'openrouter', apiKey: 'sk-or-1' }, by: ALICE }]);
  });

  it('refuses args the endpoint body refuses, before a run is made', async () => {
    const { r, asked, turn } = await started();
    await expect(call(r, turn, 'set_budget', { target: { scope: 'hub' }, period: 'per-turn', maxCost: 2, onLimit: 'explode' })).rejects.toBeInstanceOf(RunRefused);
    await expect(call(r, turn, 'set_budget', { target: { scope: 'galaxy' }, period: 'per-turn', maxCost: 2, onLimit: 'refuse' })).rejects.toBeInstanceOf(RunRefused);
    expect(asked).toEqual([]);
  });

  it('refuses a person who is not an admin', async () => {
    const { r, asked, turn } = await started();
    await r.store.table('turns').update(turn.id, { user: { ...ALICE_INFO, role: 'member' } });
    const settled = await call(r, turn, 'set_budget', { target: { scope: 'hub' }, period: 'per-turn', maxCost: 2, onLimit: 'refuse' });
    expect(settled).toMatchObject({ status: 'failed', error: { message: 'only an admin can change this' } });
    expect(asked).toEqual([]);
  });
});
