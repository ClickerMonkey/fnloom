/**
 * The hub-platform slices over the web: model roles, model calls and fn metrics, and hub MCPs. Each endpoint runs the
 * module behind it (faked here) through the same operations and reads as the hub's fns.
 */
import { describe, expect, it } from 'vitest';
import {
  ActorId, HubMcpId, McpSlug, mintId, ModelCallId, QualifiedName, type HubMcpView, type ModelCall, type ModelRoleView, type Tokens,
} from '@harness/core';
import { ScryptHasher } from '../hash.ts';
import { rig, webRig, type Fakes } from '../testing/rig.ts';

async function signedIn(fakes: Fakes = {}) {
  const r = await rig(fakes);
  const web = await webRig(r);
  const tokens = await web.admin();
  return { r, web, as: web.as(tokens), me: tokens.user.id };
}

/** A member signed in, to check the admin slices refuse them. */
async function member(r: Awaited<ReturnType<typeof rig>>, web: Awaited<ReturnType<typeof webRig>>): Promise<Tokens> {
  const id = mintId('actor');
  await r.store.table('actors').insert({ id, kind: 'user', name: 'Mem', about: '', email: 'mem@example.com', role: 'member', createdAt: 1, disabled: false });
  await r.store.table('credentials').insert({ user: id, kind: 'password', secretHash: await new ScryptHasher(10).hash('member password'), createdAt: 1 });
  return web.client.call('signIn', { email: 'mem@example.com', password: 'member password' });
}

const ROLE: ModelRoleView = { role: 'transcribe', from: 'setting', choice: { role: 'transcribe', model: { model: 'whisper-1' } }, resolved: { model: 'whisper-1', provider: 'openai' } };

const CALL: ModelCall = {
  id: ModelCallId.parse('mdl_1'), modality: 'embed', provider: 'openai', model: 'e', units: { modality: 'embed', texts: 1, characters: 3, dimensions: 8 }, cost: 0, status: 'done',
  sent: 3, received: 64, queued: 0, startedAt: 1,
};

const MCP: HubMcpView = {
  id: HubMcpId.parse('mcp_1'), slug: McpSlug.parse('claude'), name: 'Claude', instructions: '', rules: { include: {}, exclude: {} }, toolMode: 'each',
  user: ActorId.parse('act_admin'), actor: ActorId.parse('act_mcp'), grantees: [], origins: [], enabled: true, createdBy: ActorId.parse('act_admin'), createdAt: 1, updatedAt: 1,
  url: '/mcp/claude', sessions: 0, callsToday: 0,
};

describe('model roles over the web', () => {
  it('list, set and clear roles as the admin, and refuse members', async () => {
    const asked: string[] = [];
    const { r, web, as, me } = await signedIn({
      models: {
        roles: {
          list: () => Promise.resolve([ROLE]),
          set: (choice, by) => { asked.push(`set ${choice.role} by ${by}`); return Promise.resolve(ROLE); },
          clear: (role, by) => { asked.push(`clear ${role} by ${by}`); return Promise.resolve({ role, from: 'none' }); },
        },
      },
    });
    await expect(web.client.call('modelRoles', {}, as)).resolves.toEqual([ROLE]);
    await expect(web.client.call('setModelRole', { role: 'transcribe', model: { model: 'whisper-1' } }, as)).resolves.toEqual(ROLE);
    await expect(web.client.call('clearModelRole', { role: 'speak' }, as)).resolves.toEqual({ role: 'speak', from: 'none' });
    expect(asked).toEqual([`set transcribe by ${me}`, `clear speak by ${me}`]);
    const mem = await member(r, web);
    await expect(web.client.call('modelRoles', {}, web.as(mem))).rejects.toMatchObject({ status: 403 });
  });
});

describe('metrics over the web', () => {
  it('list and read model calls, and give fn metrics and a fn’s days', async () => {
    const days: Array<{ fn: string; days: number }> = [];
    const { web, as } = await signedIn({
      metrics: {
        calls: { list: (query) => Promise.resolve({ items: query.modality === 'chat' ? [] : [CALL] }), get: (id) => Promise.resolve(id === CALL.id ? CALL : undefined) },
        fns: {
          metrics: () => Promise.resolve([]),
          days: (fn, n) => { days.push({ fn, days: n }); return Promise.resolve([]); },
        },
      },
    });
    await expect(web.client.call('modelCalls', {}, as)).resolves.toEqual({ items: [CALL] });
    await expect(web.client.call('modelCalls', { modality: 'chat' }, as)).resolves.toEqual({ items: [] });
    await expect(web.client.call('modelCall', { id: CALL.id }, as)).resolves.toEqual(CALL);
    await expect(web.client.call('modelCall', { id: ModelCallId.parse('mdl_none') }, as)).rejects.toMatchObject({ status: 404 });
    await expect(web.client.call('fnMetrics', { days: 7 }, as)).resolves.toEqual([]);
    await web.client.call('fnMetricsDays', { fn: QualifiedName.parse('fs/read') }, as);
    await web.client.call('fnMetricsDays', { fn: QualifiedName.parse('fs/read'), days: 3 }, as);
    expect(days).toEqual([{ fn: 'fs/read', days: 30 }, { fn: 'fs/read', days: 3 }]);
  });
});

describe('hub MCPs over the web', () => {
  it('make one and show its secret once, change, rotate, preview and remove it, and list sessions', async () => {
    const asked: string[] = [];
    const { web, as, me } = await signedIn({
      mcp: {
        registry: {
          list: () => Promise.resolve([MCP]),
          get: (id) => Promise.resolve(id === MCP.id ? MCP : undefined),
          create: (input, by) => { asked.push(`create ${input.slug} by ${by}`); return Promise.resolve({ mcp: MCP, secret: 'hmcp_new' }); },
          update: (id, change) => { asked.push(`update ${id} ${Object.keys(change).join(',')}`); return Promise.resolve(MCP); },
          rotate: (id) => { asked.push(`rotate ${id}`); return Promise.resolve({ secret: 'hmcp_rotated' }); },
          remove: (id) => { asked.push(`remove ${id}`); return Promise.resolve(true); },
        },
        scopes: { preview: () => Promise.resolve({ fns: [], types: [], closure: [], context: [], resources: [], reach: [], warnings: ['careful'] }) },
        endpoints: { sessions: () => Promise.resolve([{ mcp: MCP.id, session: 's1', label: 'secret', since: 1, calls: 2 }]) },
      },
    });
    const { id: _id, actor: _actor, createdBy: _by, createdAt: _at, updatedAt: _up, url: _url, sessions: _s, callsToday: _c, ...input } = MCP;
    await expect(web.client.call('createMcp', input, as)).resolves.toEqual({ mcp: MCP, secret: 'hmcp_new' });
    await expect(web.client.call('mcps', {}, as)).resolves.toEqual([MCP]);
    await expect(web.client.call('mcp', { mcp: HubMcpId.parse('mcp_none') }, as)).rejects.toMatchObject({ status: 404 });
    await web.client.call('updateMcp', { mcp: MCP.id, enabled: false }, as);
    await expect(web.client.call('rotateMcpSecret', { mcp: MCP.id }, as)).resolves.toEqual({ secret: 'hmcp_rotated' });
    await expect(web.client.call('previewMcp', { rules: { include: {}, exclude: {} } }, as)).resolves.toMatchObject({ warnings: ['careful'] });
    await expect(web.client.call('mcpSessions', { mcp: MCP.id }, as)).resolves.toMatchObject([{ session: 's1', calls: 2 }]);
    await expect(web.client.call('deleteMcp', { mcp: MCP.id }, as)).resolves.toEqual({ ok: true });
    expect(asked).toEqual([`create claude by ${me}`, `update ${MCP.id} enabled`, `rotate ${MCP.id}`, `remove ${MCP.id}`]);
  });
});
