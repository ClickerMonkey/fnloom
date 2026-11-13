/**
 * The chat slice: sessions, messages, sending and `!` invocations, session controls, presence, the budget meter and
 * what the composer may offer (`capabilities`). Each handler checks the person may see the session, then hands the
 * work to the chat and execution modules.
 */
import { plugin } from '@ayepi/plugin';
import { chatSlice, compact, qualify, type ChatCapabilities, type SessionId, type SystemName, type UserView } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { personOperations } from '../person-ops.ts';
import { HUB_SYSTEM, systemAvailability } from '../../catalog/availability.ts';
import { AGENT_KIND } from '../../execution/index.ts';
import { allRows } from '../../store/rows.ts';
import { CLIENTS_PATH } from '../serve.ts';
import { userInfo, visibleSession, type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';
import { dictationOf } from '../../models/roles.ts';
import { clientItemName } from '../../link/lifecycle.ts';
import { visibleMade } from '../../resources/context.ts';
import type { HubReads } from '../reads.ts';

/** Whether a session lets a system's contributions in. */
const allows = (systems: readonly SystemName[] | 'all', system: SystemName): boolean => systems === 'all' || systems.includes(system);

/** What the composer may offer now: every input is offered only when something can serve it. */
export async function capabilities(hub: HubServices, user: UserView, session?: SessionId): Promise<ChatCapabilities> {
  const scope = session === undefined ? 'all' : (await visibleSession(hub, session, user)).systems;
  const systems = (await allRows(hub.store.table('systems'), { order: [['name', 'asc']] }))
    .filter((s) => s.status !== 'removed');
  const access = await hub.access.scope(user.id);
  // a system shared with someone else is as good as absent here
  const seen = systems.filter((s) => access.seesSystem(s.name));
  // an installed system (not yet live) offers nothing, like one that is not connected
  const usable = new Set(seen.filter((s) => systemAvailability(s.name, s) === true && s.enabled.functions && allows(scope, s.name)).map((s) => s.name));
  const [commandsOff, mentionsOff, componentsOff] = await Promise.all([hub.link.lifecycle.off('commands'), hub.link.lifecycle.off('mentions'), hub.link.lifecycle.off('components')]);
  const seenNames = new Set(seen.map((s) => s.name));
  /** Why a seen system's commands can't run in this session now. */
  const unusableReason = (name: SystemName): string => {
    const record = seen.find((s) => s.name === name);
    if (!allows(scope, name)) { return `the ${name} system is not enabled in this session`; }
    const available = systemAvailability(name, record);
    return available === true ? `the ${name} system has its functions switched off` : available.detail;
  };
  const rendering = seen.filter((s) => s.enabled.renderers && allows(scope, s.name));
  const [mentions, declared, madeAll, fnsAll, models, manifests, types, dictate] = await Promise.all([
    hub.catalog.entries('mentions'),
    hub.catalog.entries('context'),
    // memory and context made from resources aren't in any manifest; a person sees the ones in their reach
    visibleMade(hub.store, { actor: user.id, session }),
    hub.catalog.fns({ available: true }),
    hub.execution.llm.models(),
    Promise.all(rendering.map(async (s) => ({ system: s.name, manifest: await hub.catalog.manifest(s.name) }))),
    hub.catalog.entries('types'),
    hub.models.roles.get('dictate'),
  ]);
  const fns = fnsAll.filter((f) => access.mayUse(f));
  const contexts = declared.filter((c) => access.seesContext({ name: c.name, system: c.system }));
  const made = madeAll.filter((c) => access.seesContext(c));
  const dictation = dictationOf(dictate);
  // a type's methods run on a value, from its mention's hover card, so they aren't offered as free `!` fns
  const methods = new Set(types.flatMap((t) => t.decl.methods.map((method) => `${t.name}.${method}`)));
  const byName = new Map(fns.map((f) => [f.name, f]));
  /** Whether a person may run a fn by hand: its system is usable here and its visibility lets people see it. */
  const byHand = (f: (typeof fns)[number]): boolean => usable.has(f.system) && f.decl.visibility !== 'llm' && f.decl.visibility !== 'none';
  return {
    voiceInput: dictation !== undefined,
    ...(dictation === undefined ? {} : { dictation }),
    voiceOutput: false,
    uploads: true,
    mentions: mentions.filter((m) => usable.has(m.system) && !mentionsOff.has(m.name)).map((m) => ({ provider: m.name, title: m.decl.title, ...(m.decl.of === undefined ? {} : { of: m.decl.of }) })),
    // hub-made context (memories, context from resources) is always usable; a system's says why it can't run now
    commands: [...contexts.filter((c) => seenNames.has(c.system)), ...made].flatMap((c) => {
      if (c.decl.command === undefined) { return []; }
      const why = commandsOff.has(`/${c.decl.command.name}`) ? `/${c.decl.command.name} is switched off`
        : c.system === HUB_SYSTEM || usable.has(c.system) ? undefined : unusableReason(c.system);
      return [{ name: c.decl.command.name, context: c.name, args: c.decl.command.args, description: c.decl.description, ...(why === undefined ? {} : { unavailable: why }) }];
    }),
    agents: fns.filter((f) => (f.system === HUB_SYSTEM || usable.has(f.system)) && f.decl.kind === AGENT_KIND).map((f) => ({ fn: f.name, description: f.decl.description })),
    display: Object.fromEntries(fns.filter((f) => f.decl.display !== 'card').map((f) => [f.name, f.decl.display])),
    invocations: fns.filter((f) => byHand(f) && !methods.has(f.name)).map((f) => ({ fn: f.name, description: f.decl.description, args: f.decl.args })),
    methods: types.flatMap((t) => t.decl.methods.flatMap((method) => {
      const f = byName.get(qualify(t.system, `${t.decl.name}.${method}`));
      return f === undefined || !byHand(f) ? [] : [{ type: t.name, method, fn: f.name, description: f.decl.description, args: f.decl.args }];
    })),
    // a client build switched off, or changed and waiting for review, is not loaded
    clients: manifests.flatMap(({ system, manifest }) => (manifest?.client === undefined || componentsOff.has(clientItemName(system)) ? [] : [{
      system, url: clientUrl(system, manifest.client.hash, manifest.client.entry), hash: manifest.client.hash,
    }])),
    systems: seen.filter((s) => allows(scope, s.name)).map((s) => ({ name: s.name, status: s.status, enabled: s.enabled.functions })),
    // the picker offers models that chat: an embedding or rerank model can't answer
    models: models.filter((model) => model.capabilities.includes('chat') && !model.capabilities.some((c) => c === 'embedding' || c === 'rerank')),
  };
}

/** Where the hub serves a file of a system's client build (`ClientBuildRoute` in `api/serve.ts`). */
export function clientUrl(system: SystemName, hash: string, path: string): string {
  return `${CLIENTS_PATH}${encodeURIComponent(system)}/${hash}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The chat plugin. */
export function chatPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  const person = personOperations(hub);
  const { chat, execution } = hub;
  return plugin({ name: 'web.chat', spec: chatSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof chatSlice> => ({
      capabilities: (io) => capabilities(hub, io.user, io.data.session),
      types: ({ data, user }) => reads.types_get(data, user),
      sessions: ({ data, user }) => reads.sessions_list(data, user),
      session: ({ data, user }) => visibleSession(hub, data.session, user),
      createSession: ({ data, user }) => person.session_create(data, user),
      updateSession: ({ data, user }) => person.session_update(data, user),
      deleteSession: ({ data, user }) => person.session_delete(data, user),
      limits: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return execution.limits.resolve({ user: await userInfo(hub, user), session: data.session });
      },
      messages: ({ data, user }) => reads.session_messages(data, user),
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
        return chat.sessions.control(data.session, data.action, user.id, data.runs);
      },
      presence: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        await chat.sessions.presence({ ...data, user: user.id });
      },
    }));
}
