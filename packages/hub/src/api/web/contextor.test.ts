/**
 * The contextor slice over the web: each model's limits with their sources, an admin setting a model's limits (members
 * refused), and a preview of a session's prompt only for someone who may see the session.
 */
import { describe, expect, it } from 'vitest';
import { mintId, type SelectionReport, type Session, type SessionId, type Tokens } from '@harness/core';
import { createContextor } from '../../contextor/create.ts';
import { contextorEnv } from '../../contextor/env.ts';
import { chatModel, ContextCatalog, FixedSearch } from '../../contextor/testing.ts';
import { memoryLog, testStore } from '../../testing.ts';
import { ScryptHasher } from '../hash.ts';
import { rig, webRig } from '../testing/rig.ts';

const REPORT: SelectionReport = {
  contextor: 'plain', mode: 'tools', context: [], fns: [], linear: 0, earlier: [],
  budget: { window: 2_048, output: 256, reasoning: 0, margin: 123, fixed: 40, pools: { history: { asked: 0, got: 0 }, context: { asked: 0, got: 0 }, fns: { asked: 0, got: 0 } }, estimate: 40, cut: [] },
};

/** A hub with real model limits over its store, sessions only their owner sees, and a preview that records who asked. */
async function signedIn() {
  const previews: Array<{ session: SessionId; text: string }> = [];
  const owned = new Map<SessionId, string>();
  const r = await rig({
    contextor: {
      planner: { preview: (session, text) => { previews.push({ session, text }); return Promise.resolve(REPORT); } },
    },
    chat: {
      sessions: {
        get: (session, viewer): Promise<Session | undefined> => {
          const owner = owned.get(session);
          return Promise.resolve(owner === undefined || owner !== viewer ? undefined : {
            id: session, title: 'T', owner, agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript: [],
            createdAt: 0, updatedAt: 0, archived: false,
          });
        },
      },
    },
  });
  const web = await webRig(r);
  const admin = await web.admin();
  return { r, web, admin, previews, owned };
}

/** A member signed in. */
async function member(r: Awaited<ReturnType<typeof rig>>, web: Awaited<ReturnType<typeof webRig>>): Promise<Tokens> {
  const id = mintId('actor');
  await r.store.table('actors').insert({ id, kind: 'user', name: 'Mem', about: '', email: 'mem@example.com', role: 'member', createdAt: 1, disabled: false });
  await r.store.table('credentials').insert({ user: id, kind: 'password', secretHash: await new ScryptHasher(10).hash('member password'), createdAt: 1 });
  return web.client.call('signIn', { email: 'mem@example.com', password: 'member password' });
}

describe('the contextor over the web', () => {
  it('previews a session\'s prompt for someone who may see it, and refuses everyone else', async () => {
    const { r, web, admin, previews, owned } = await signedIn();
    const mem = await member(r, web);
    const theirs = mintId('session');
    const mine = mintId('session');
    owned.set(theirs, admin.user.id);
    owned.set(mine, mem.user.id);
    await expect(web.client.call('previewSelection', { session: mine, text: 'hello' }, web.as(mem))).resolves.toEqual(REPORT);
    await expect(web.client.call('previewSelection', { session: theirs, text: 'peek' }, web.as(mem))).rejects.toMatchObject({ status: 404 });
    expect(previews).toEqual([{ session: mine, text: 'hello' }]);
  });
});

describe('model limits over the web', () => {
  /** The rig with the real limits service over its own store, one chat model offered. */
  async function withLimits() {
    const contextor = createContextor({
      store: await testStore(), catalog: new ContextCatalog(), search: new FixedSearch(), settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: 'small' },
      models: () => Promise.resolve([chatModel('small', { contextWindow: 8_192 })]), log: memoryLog().log, clock: () => 0, probes: () => undefined,
    });
    const { limits } = contextor;
    const limited = await rig({ contextor: { limits: { resolve: (model) => limits.resolve(model), list: () => limits.list(), set: (model, set, by) => limits.set(model, set, by) } } });
    const web = await webRig(limited);
    return { r: limited, web, admin: await web.admin() };
  }

  it('lets an admin set a model\'s limits, which then read back with the admin as their source', async () => {
    const { web, admin } = await withLimits();
    const as = web.as(admin);
    const before = await web.client.call('modelLimits', { model: 'small' }, as);
    expect(before).toMatchObject([{ model: 'small', limits: { contextWindow: 8_192 }, sources: { contextWindow: 'model-info' } }]);
    await expect(web.client.call('setModelLimits', { model: 'small', limits: { contextWindow: 4_096, maxOutputTokens: 512 } }, as))
      .resolves.toMatchObject({ model: 'small', limits: { contextWindow: 4_096, maxOutputTokens: 512 }, sources: { contextWindow: 'admin', maxOutputTokens: 'admin' } });
    await expect(web.client.call('modelLimits', { model: 'small' }, as)).resolves.toMatchObject([{ limits: { contextWindow: 4_096 }, sources: { contextWindow: 'admin' } }]);
  });

  it('refuses a member setting limits, while letting them read them', async () => {
    const { r, web } = await withLimits();
    const mem = await member(r, web);
    await expect(web.client.call('setModelLimits', { model: 'small', limits: { contextWindow: 1_024 } }, web.as(mem))).rejects.toMatchObject({ status: 403 });
    await expect(web.client.call('modelLimits', { model: 'small' }, web.as(mem))).resolves.toMatchObject([{ sources: { contextWindow: 'model-info' } }]);
  });
});
