/**
 * The chat slice: sessions, messages, sending and `!` invocations, session controls, presence, the budget meter and
 * what the composer may offer (`capabilities`). Each handler checks the person may see the session, then hands the
 * work to the chat and execution modules.
 */
import { plugin } from '@ayepi/plugin';
import { qualify, type ChatCapabilities, type SessionId, type SystemName, type UserView } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { collect, PAGE } from '../paging.ts';
import { CLIENTS_PATH } from '../serve.ts';
import { compact, userInfo, visibleSession, type FullHandlers } from './access.ts';
import { chatSlice } from './slices.ts';
import type { authPlugin } from './auth.ts';

/** Whether a session lets a system's contributions in. */
const allows = (systems: readonly SystemName[] | 'all', system: SystemName): boolean => systems === 'all' || systems.includes(system);

/** What the composer may offer now: every input is offered only when something can serve it. */
export async function capabilities(hub: HubServices, user: UserView, session?: SessionId): Promise<ChatCapabilities> {
  const scope = session === undefined ? 'all' : (await visibleSession(hub, session, user)).systems;
  const systems = (await collect((cursor) => hub.store.table('systems').find({ order: [['name', 'asc']], limit: PAGE, cursor })))
    .filter((s) => s.status !== 'removed');
  const usable = new Set(systems.filter((s) => s.status === 'connected' && s.enabled.functions && allows(scope, s.name)).map((s) => s.name));
  const rendering = systems.filter((s) => s.enabled.renderers && allows(scope, s.name));
  const [mentions, contexts, fns, models, manifests] = await Promise.all([
    hub.catalog.entries('mentions'),
    hub.catalog.entries('context'),
    hub.catalog.fns({ available: true }),
    hub.execution.llm.models(),
    Promise.all(rendering.map(async (s) => ({ system: s.name, manifest: await hub.catalog.manifest(s.name) }))),
  ]);
  return {
    voiceInput: false,
    voiceOutput: false,
    uploads: true,
    mentions: mentions.filter((m) => usable.has(m.system)).map((m) => ({ provider: m.name, title: m.decl.title })),
    commands: contexts.filter((c) => usable.has(c.system)).flatMap((c) => (c.decl.command === undefined ? [] : [{
      name: c.decl.command.name, context: c.name, args: c.decl.command.args, description: c.decl.description,
    }])),
    invocations: fns.filter((f) => usable.has(f.system) && f.decl.visibility !== 'llm' && f.decl.visibility !== 'none').map((f) => ({
      fn: f.name, description: f.decl.description, args: f.decl.args,
    })),
    clients: manifests.flatMap(({ system, manifest }) => (manifest?.client === undefined ? [] : [{
      system, url: clientUrl(system, manifest.client.hash, manifest.client.entry), hash: manifest.client.hash,
    }])),
    systems: systems.filter((s) => allows(scope, s.name)).map((s) => ({ name: s.name, status: s.status, enabled: s.enabled.functions })),
    models,
  };
}

/** Where the hub serves a file of a system's client build (`ClientBuildRoute` in `api/serve.ts`). */
export function clientUrl(system: SystemName, hash: string, path: string): string {
  return `${CLIENTS_PATH}${encodeURIComponent(system)}/${hash}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The chat plugin. */
export function chatPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const { chat, execution } = hub;
  return plugin({ name: 'web.chat', spec: chatSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof chatSlice> => ({
      capabilities: ({ data, user }) => capabilities(hub, user, data.session),
      sessions: ({ data, user }) => chat.sessions.list(user.id, compact(data)),
      session: ({ data, user }) => visibleSession(hub, data.session, user),
      createSession: async ({ data, user }) => {
        const session = await chat.sessions.create({ ...compact(data), owner: user.id, agent: data.agent ?? qualify('hub', 'chat') });
        hub.log.info('session.created', { session: session.id, user: user.id });
        return session;
      },
      updateSession: async ({ data: { session, ...patch }, user }) => {
        await visibleSession(hub, session, user);
        return chat.sessions.update(session, compact(patch), user.id);
      },
      limits: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return execution.limits.resolve({ user: await userInfo(hub, user), session: data.session });
      },
      messages: async ({ data: { session, ...page }, user }) => {
        await visibleSession(hub, session, user);
        return chat.sessions.messages(session, user.id, compact(page));
      },
      send: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return chat.turns.send({ ...compact(data), author: user.id });
      },
      invoke: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return chat.turns.invoke({ ...data, author: user.id });
      },
      control: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return chat.sessions.control(data.session, data.action, user.id);
      },
      presence: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        await chat.sessions.presence({ ...data, user: user.id });
      },
    }));
}
