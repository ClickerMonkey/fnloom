import { ADMIN_ENDPOINTS, encodeValue, fn, hub, manifestOf, type AdminFnName, type FnRef } from '@harness/sdk';
import { ADMIN_TAG, INVALID_INPUT_CODE, QualifiedName, READ_TAG, type Json, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminOperations } from '../api/admin-ops.ts';
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
    remove_rule: unused, approve_pairing: unused, create_pairing_token: unused, configure_system: unused, enable_system: unused, switch_item: unused, remove_system: unused,
    install_system: unused, start_system: unused, stop_system: unused, restart_system: unused, upgrade_system: unused, set_model_role: unused, clear_model_role: unused,
    set_model_limits: unused, create_mcp: unused, update_mcp: unused, rotate_mcp_secret: unused, delete_mcp: unused, preview_mcp: unused,
    install_package: unused, remove_instance: unused, export_system_data: unused, suggest_decision_set: unused, auto_pair_revoke: unused, system_reimport: unused,
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
  it('offers every admin endpoint as a hub fn, tagged admin and never read, each implemented', async () => {
    const r = await executionRig();
    rig = r;
    registerAdminFns(r.module.hubFns, () => recordingOps([]));
    const manifest = await manifestOf(hub, { version: 'test' });
    expect(ADMIN_FN_NAMES).toEqual(Object.keys(ADMIN_ENDPOINTS));
    for (const name of ADMIN_FN_NAMES) {
      const decl = manifest.fns.find((f) => f.name === name);
      expect(decl, name).toBeDefined();
      expect(decl?.tags, name).not.toContain(READ_TAG);
      // tagged admin: never exposed through a hub MCP
      expect(decl?.tags, name).toContain(ADMIN_TAG);
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
    expect(await call(r, turn, 'configure_provider', { provider: 'openrouter', apiKey: 'sk-or-1' })).toEqual({ status: 'done', result: { models: 3 } });
    expect(asked).toEqual([{ op: 'configure_provider', data: { provider: 'openrouter', apiKey: 'sk-or-1' }, by: ALICE }]);
  });

  it('refuses args the endpoint body refuses as invalid input, before the operation runs', async () => {
    const { r, asked, turn } = await started();
    await expect(call(r, turn, 'set_budget', { target: { scope: 'hub' }, period: 'per-turn', maxCost: 2, onLimit: 'explode' }))
      .resolves.toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE, data: { source: 'schema', problems: [{ path: 'onLimit' }] } } });
    await expect(call(r, turn, 'set_budget', { target: { scope: 'galaxy' }, period: 'per-turn', maxCost: 2, onLimit: 'refuse' }))
      .resolves.toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE } });
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

/** The args a hub fn ref takes. */
type ArgsOf<F> = F extends FnRef<QualifiedName, infer A, unknown> ? A : never;

/** One valid body for every admin fn (the compiler checks each against its fn's args). */
const ADMIN_EXAMPLES: { readonly [N in AdminFnName]: ArgsOf<(typeof hub.fns)[N]> } = {
  configure_provider: { provider: 'ollama' },
  set_model_category: { name: 'fast', description: 'Fast ones.', models: ['m'] },
  set_budget: { target: { scope: 'hub' }, period: 'per-turn', maxCost: 1, onLimit: 'refuse' },
  set_priority: { target: { scope: 'hub' } },
  set_policy: { description: 'all', subject: { everyone: true }, target: {}, decision: { effect: 'allow' }, priority: 1 },
  set_actor_setting: { setting: 'hub/theme', actor: ALICE, value: 'dark' },
  add_user: { email: 'bo@example.com', name: 'Bo', role: 'member' },
  add_group: { name: 'team', about: 'A team.' },
  remove_rule: { kind: 'budget', id: 'bgt_1' },
  approve_pairing: { pairing: 'par_1', approve: true },
  create_pairing_token: { expiresIn: 60 },
  configure_system: { system: 'fs', config: {} },
  enable_system: { system: 'fs', functions: true },
  switch_item: { section: 'context', name: 'fs/guide', on: false },
  remove_system: { system: 'fs' },
  install_system: { source: { path: 'systems/fs' } },
  start_system: { system: 'fs' },
  stop_system: { system: 'fs' },
  restart_system: { system: 'fs', reason: 'stuck' },
  suggest_decision_set: { enabled: false },
  auto_pair_revoke: { id: 'apk_1' },
  system_reimport: { system: 'fs' },
  upgrade_system: { system: 'fs' },
  set_model_role: { role: 'chat', model: { model: 'm' } },
  clear_model_role: { role: 'chat' },
  set_model_limits: { model: 'm', limits: {} },
  create_mcp: {
    slug: 'claude', name: 'Claude', instructions: '', rules: { include: {}, exclude: {} }, toolMode: 'each', user: ALICE, grantees: [], origins: [], enabled: true,
  },
  update_mcp: { mcp: 'mcp_1' },
  rotate_mcp_secret: { mcp: 'mcp_1' },
  delete_mcp: { mcp: 'mcp_1' },
  preview_mcp: { rules: { include: {}, exclude: {} } },
  install_package: { zip: { hash: 'a'.repeat(64), size: 1, mime: 'application/zip' } },
  remove_instance: { system: 'fs', instance: 'one' },
  export_system_data: { system: 'fs', instance: 'one' },
};

describe('every admin fn', () => {
  it('runs the operation of its own name', async () => {
    const r = await executionRig();
    rig = r;
    for (const name of ADMIN_FN_NAMES) { addAdminFn<unknown, unknown>(r, hub.fns[name]); }
    /** Each operation fails naming itself, so a run shows which one it reached. */
    const reached = (name: AdminFnName) => (): Promise<never> => Promise.reject(new Error(`reached ${name}`));
    const ops: AdminOperations = {
      configure_provider: reached('configure_provider'), set_model_category: reached('set_model_category'), set_budget: reached('set_budget'),
      set_priority: reached('set_priority'), set_policy: reached('set_policy'), set_actor_setting: reached('set_actor_setting'), add_user: reached('add_user'),
      add_group: reached('add_group'), remove_rule: reached('remove_rule'), approve_pairing: reached('approve_pairing'),
      create_pairing_token: reached('create_pairing_token'), configure_system: reached('configure_system'), enable_system: reached('enable_system'), switch_item: reached('switch_item'),
      remove_system: reached('remove_system'), install_system: reached('install_system'), start_system: reached('start_system'), stop_system: reached('stop_system'), restart_system: reached('restart_system'),
      upgrade_system: reached('upgrade_system'), set_model_role: reached('set_model_role'), clear_model_role: reached('clear_model_role'),
      set_model_limits: reached('set_model_limits'), create_mcp: reached('create_mcp'), update_mcp: reached('update_mcp'),
      rotate_mcp_secret: reached('rotate_mcp_secret'), delete_mcp: reached('delete_mcp'), preview_mcp: reached('preview_mcp'),
      suggest_decision_set: reached('suggest_decision_set'), auto_pair_revoke: reached('auto_pair_revoke'), system_reimport: reached('system_reimport'),
      install_package: reached('install_package'), remove_instance: reached('remove_instance'), export_system_data: reached('export_system_data'),
    };
    registerAdminFns(r.module.hubFns, () => ops);
    await r.session();
    await r.module.start();
    const turn = await r.turn({ session: SESSION, text: 'change everything' });
    for (const name of ADMIN_FN_NAMES) {
      const ref = hub.fns[name];
      const args = encodeValue<unknown>(ref.args, ADMIN_EXAMPLES[name]);
      expect(await call(r, turn, name, args), name).toMatchObject({ status: 'failed', error: { message: `reached ${name}` } });
    }
  });
});
