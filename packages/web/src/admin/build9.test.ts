/**
 * Build 9 on the admin pages: MCP servers as a fleet added from the browser (their config drafts with kept secrets, the
 * stores' calls, a server's status and look), and the connect page's instance cards. API services: `api-services.test.ts`.
 */
import { ActorId, ConnectPage, InstanceName, InstanceView, Json, SECRET_KEPT, type McpServerStatus } from '@harness/core';
import { ApiError } from '@ayepi/core/client';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import McpServerForm from './components/McpServerForm.vue';
import { countsText, mcpServerConfig, mcpServerDraft, mirrorPrefix, serverLook } from './logic/mcp-servers.ts';
import { authCandidate, authDraft, instanceNameOf, withoutKept } from './logic/remote-config.ts';
import { McpServersStore, promptsQuery } from './state/mcp-servers.ts';
import { fakeAdminApi } from './test/fakes.ts';
import { instanceCards } from '../connect/logic.ts';
import { fakeCaller } from '../test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });
const linear = InstanceName.parse('linear');

/** A saved server config as the hub sends it: secrets kept. */
const SAVED: Json = {
  label: 'GitHub', transport: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: SECRET_KEPT },
  auth: { kind: 'none' }, trusted: false, approval: 'writes', prompts: true, resources: false, maxTools: 50, timeout: 30_000,
};

describe('remote service configs', () => {
  it('reads a saved MCP server with kept secrets and sends them back kept', () => {
    const draft = mcpServerDraft(SAVED);
    expect(draft).toMatchObject({ label: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], envKept: true, resources: false, maxTools: '50', timeout: '30' });
    const checked = mcpServerConfig(draft);
    expect(checked.ok && checked.config['transport']).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: SECRET_KEPT });
    // replacing the environment sends the new values
    const replaced = mcpServerConfig({ ...draft, envKept: false, env: [{ name: 'GITHUB_TOKEN', value: 'ghp_1' }] });
    expect(replaced.ok && replaced.config['transport']).toMatchObject({ env: { GITHUB_TOKEN: 'ghp_1' } });
  });

  it('starts a new server from the schema defaults and says which fields are wrong, by path', () => {
    const draft = mcpServerDraft();
    expect(draft).toMatchObject({ transport: 'http', approval: 'writes', prompts: true, maxTools: '200', timeout: '120' });
    const checked = mcpServerConfig({ ...draft, url: 'not a url', timeout: 'soon' });
    expect(checked.ok).toBe(false);
    if (!checked.ok) { expect(Object.keys(checked.problems).sort()).toEqual(['label', 'timeout', 'transport.url']); }
  });

  it('keeps a shared token left blank, drops it for per-person, and replaces header values as a whole', () => {
    const kept = new Set(['auth.token', 'auth.values']);
    const bearer = authDraft({ kind: 'bearer', per: 'shared' }, kept);
    expect(authCandidate(bearer)).toEqual({ auth: { kind: 'bearer', per: 'shared' }, kept: ['auth.token'] });
    expect(authCandidate({ ...bearer, token: 'new' })).toEqual({ auth: { kind: 'bearer', per: 'shared', token: 'new' }, kept: [] });
    expect(authCandidate({ ...bearer, per: 'person' })).toEqual({ auth: { kind: 'bearer', per: 'person' }, kept: [] });
    const headers = authDraft({ kind: 'headers', per: 'shared', names: ['X-Api-Key'] }, kept);
    expect(authCandidate(headers)).toEqual({ auth: { kind: 'headers', per: 'shared', names: ['X-Api-Key'] }, kept: ['auth.values'] });
    const typed = { ...headers, kept: [], headers: [{ name: 'X-Api-Key', value: 'k1' }] };
    expect(authCandidate(typed).auth).toEqual({ kind: 'headers', per: 'shared', names: ['X-Api-Key'], values: { 'X-Api-Key': 'k1' } });
  });

  it('drops a kept secret from a config so its own schema reads it', () => {
    const saved: Json = { label: 'Linear', baseUrl: 'https://api.linear.app', auth: { kind: 'bearer', per: 'shared', token: SECRET_KEPT } };
    expect(withoutKept(saved, ['auth.token'])).not.toHaveProperty('auth.token');
  });

  it('makes instance names from labels and the mirror prefix from the instance', () => {
    expect(instanceNameOf('Linear tickets!')).toBe('linear-tickets');
    expect(instanceNameOf('123')).toBeUndefined();
    expect(mirrorPrefix(InstanceName.parse('my-server'))).toBe('my_server_');
    expect(promptsQuery(linear).query.filters).toContainEqual({ field: 'name', op: 'contains', value: 'linear_' });
  });
});

const STATUS: McpServerStatus = { instance: linear, state: 'needs-auth', tools: 1, prompts: 2, resources: 0, degraded: [], leftOut: 0, checkedAt: 1 };

describe('MCP servers store', () => {
  it('reads each server status, and says plainly when it cannot', async () => {
    const view = InstanceView.parse({ system: 'mcp', instance: 'linear', description: '', status: 'connected', keyFingerprint: 'k', version: '1.0.0', manifestHash: 'h' });
    const api = {
      ...fakeAdminApi(),
      instances: fakeCaller<'instances'>(() => Promise.resolve([view])),
      readFn: fakeCaller<'readFn'>(() => Promise.resolve(Json.parse(STATUS))),
    };
    const store = new McpServersStore(api);
    await store.load();
    expect(api.readFn.calls[0]?.[0]).toEqual({ fn: 'mcp/server_status', args: { instance: 'linear' } });
    expect(store.statusOf(linear)?.state).toBe('needs-auth');
    expect(serverLook('connected', store.statuses.value.get(linear)).word).toBe('Needs sign-in');
    expect(countsText(STATUS)).toBe('1 tool · 2 prompts · 0 resources');

    const failing = new McpServersStore({ ...api, readFn: fakeCaller<'readFn'>(() => Promise.reject(new ApiError(500, 'X', 'boom'))) });
    await failing.readStatus(linear);
    expect(serverLook('connected', failing.statuses.value.get(linear)).word).toBe('Status unknown');
    expect(serverLook('disconnected', undefined).word).toBe('Offline');
  });

  it('adds a server as an instance of the mcp system', async () => {
    const api = fakeAdminApi();
    const store = new McpServersStore(api);
    const checked = mcpServerConfig({ ...mcpServerDraft(), label: 'Linear', url: 'https://mcp.linear.app/mcp' });
    if (!checked.ok) { throw new Error('the draft should check'); }
    const added = await store.fleet.add(linear, checked.config);
    expect(added.ok).toBe(true);
    expect(api.addInstance.calls[0]?.[0]).toMatchObject({ system: 'mcp', instance: 'linear', config: { label: 'Linear', transport: { type: 'http' } } });
  });
});

describe('MCP server form', () => {
  it('asks for a command, its arguments and environment when the transport is a command, with no sign-in', async () => {
    const wrapper = mount(McpServerForm, { props: { modelValue: mcpServerDraft(), 'onUpdate:modelValue': (next: ReturnType<typeof mcpServerDraft>) => wrapper.setProps({ modelValue: next }) } });
    expect(wrapper.find('[data-testid="server-url"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="remote-auth"]').exists()).toBe(true);
    await wrapper.setProps({ modelValue: { ...mcpServerDraft(), transport: 'stdio' } });
    expect(wrapper.find('[data-testid="server-command"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="server-env"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="remote-auth"]').exists()).toBe(false);
  });
});

describe('connect page instance cards', () => {
  it('lists instances with their own connections, and only an admin connects a shared sign-in', () => {
    const page = ConnectPage.parse({
      system: 'mcp', ready: true, decl: { title: 'MCP servers', description: '', how: { flow: 'oauth' }, settings: { name: 'obj', props: {} }, fns: {}, scope: 'instance' },
      connections: [{ id: 'cnx_1', system: 'mcp', instance: 'linear', owner: 'act_me', status: 'connected', settings: {}, fns: {}, share: { visibility: 'private', with: [] }, createdAt: 1, updatedAt: 1 }],
      instances: [
        { instance: 'linear', label: 'Linear', connect: { flow: { flow: 'oauth' }, share: false, title: 'Sign in to Linear' } },
        { instance: 'docs', label: 'Docs', connect: { share: true, flow: { flow: 'oauth' }, title: 'Sign in to Docs' } },
        { instance: 'local', label: 'A local one', connect: { share: false, title: 'Nothing to do' } },
      ],
    });
    const cards = instanceCards(page, ActorId.parse('act_me'), false);
    expect(cards.map((c) => [c.id, c.flow, c.mayConnect, c.own?.id])).toEqual([
      ['local', 'none', false, undefined], ['docs', 'oauth', false, undefined], ['linear', 'oauth', true, 'cnx_1'],
    ]);
    expect(instanceCards(page, undefined, true).find((c) => c.id === 'docs')?.mayConnect).toBe(true);
  });
});
