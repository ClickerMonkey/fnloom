import { fn, HUB_READ_ENDPOINTS, hub, manifestOf, type FnRef } from '@harness/sdk';
import { ADMIN_TAG, INVALID_INPUT_CODE, QualifiedName, READ_TAG, type Json, type Turn } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { HubReads } from '../api/reads.ts';
import type { Viewer } from '../api/web/access.ts';
import { fake } from '../api/testing/rig.ts';
import { ALICE, ALICE_INFO, executionRig, SESSION, type ExecutionRig } from '../execution/testing.ts';
import { registerMcpFns } from '../mcp/fns.ts';
import { HUB_READ_NAMES, registerReadFns } from './read-fns.ts';

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

/** Put a hub fn in the rig's catalog with the contract's args, result and tags. */
function addHubFn<A, R>(r: ExecutionRig, ref: FnRef<QualifiedName, A, R>, tags: string[]): void {
  r.catalog.add('hub', ref.name.slice('hub/'.length), fn({ description: ref.name, args: ref.args, returns: ref.returns, tags }));
}

async function started(reads: Partial<HubReads>) {
  const r = await executionRig();
  rig = r;
  addHubFn(r, hub.fns.runs_list, [READ_TAG]);
  addHubFn(r, hub.fns.system_logs, [READ_TAG]);
  addHubFn(r, hub.fns.model_roles, [READ_TAG]);
  addHubFn(r, hub.fns.mint_mcp_token, [READ_TAG]);
  registerReadFns(r.module.hubFns, () => fake<HubReads>('reads', reads));
  await r.session();
  await r.module.start();
  return { r, turn: await r.turn({ session: SESSION, text: 'hi' }) };
}

/** Run a hub fn in the turn and return how it settled. */
async function call(r: ExecutionRig, turn: Turn, name: string, args: Json) {
  return (await r.module.runs.start({
    fn: QualifiedName.parse(`hub/${name}`), args, turn: turn.id, session: SESSION, key: name, actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
  })).settled;
}

describe('read fns', () => {
  it('run the web read with the endpoint’s body, as the run’s person', async () => {
    const seen: Array<{ data: unknown; who: Viewer }> = [];
    const { r, turn } = await started({
      runs_list: (data, who) => { seen.push({ data, who }); return Promise.resolve({ items: [] }); },
    });
    expect(await call(r, turn, 'runs_list', { status: 'failed', limit: 5 })).toEqual({ status: 'done', result: { items: [] } });
    expect(seen).toEqual([{ data: { status: 'failed', limit: 5 }, who: { id: ALICE, role: 'admin' } }]);
    await r.store.table('turns').update(turn.id, { user: { ...ALICE_INFO, role: 'member' } });
    await call(r, turn, 'runs_list', {});
    expect(seen[1]?.who).toEqual({ id: ALICE, role: 'member' });
  });

  it('refuse args the endpoint refuses as invalid input, and pass a read’s refusal on', async () => {
    const { r, turn } = await started({
      system_logs: () => Promise.reject(new Error('only an admin can see a system’s output')),
    });
    expect(await call(r, turn, 'runs_list', { limit: 0 })).toMatchObject({ status: 'failed', error: { code: INVALID_INPUT_CODE } });
    expect(await call(r, turn, 'system_logs', { system: 'fs' })).toMatchObject({ status: 'failed', error: { message: /only an admin/ } });
  });

  it('are every read the contract offers but other modules’, each tagged read, and none tagged admin', async () => {
    const manifest = await manifestOf(hub, { version: 'test' });
    const reads = new Set<string>(Object.keys(HUB_READ_ENDPOINTS));
    for (const decl of manifest.fns.filter((f) => reads.has(f.name))) {
      expect(decl.tags).toContain(READ_TAG);
      expect(decl.tags).not.toContain(ADMIN_TAG);
    }
    const foreign = ['resource_list', 'resource_read', 'context_get', 'model_limits'];
    expect([...HUB_READ_NAMES, ...foreign].sort()).toEqual([...reads].sort());
  });

  it('let only a system’s fn mint an MCP token, for the system that asked', async () => {
    const asked: Array<{ system: string; ttl: number }> = [];
    const { r, turn } = await started({});
    registerMcpFns(r.module.hubFns, {
      tokens: () => ({ mint: (input) => { asked.push({ system: input.system, ttl: input.ttl }); return Promise.resolve({ token: 't', expiresAt: 5 }); } }),
      settings: { HARNESS_HUB_MCP_TOKEN_TTL: 60_000 },
    });
    // a person's own call names no system
    expect(await call(r, turn, 'mint_mcp_token', { mcp: 'mcp_1', label: 'session 1' })).toMatchObject({ status: 'failed', error: { message: /only a system/ } });
    expect(asked).toEqual([]);
  });
});
