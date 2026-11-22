/**
 * Build 6: the rest of what a person does in the browser, and the admin pages' reads, each one operation shared by its
 * web handler and the hub fn that offers it in chat (`HUB_PERSON_ENDPOINTS`, `HUB_EXPLORE_ENDPOINTS`,
 * `ADMIN_READ_ENDPOINTS`): given the endpoint's parsed body and who asks, it answers the endpoint's response. A web
 * handler and a hub fn can never do different things, and both keep to what the person may see.
 */
import { reject } from '@ayepi/core';
import { compact, InstanceView, MAIN_INSTANCE, type BudgetView, type SettingView, type TableName, type UserView } from '@harness/core';
import type { ADMIN_READ_ENDPOINTS, AdminReadFnName, HUB_EXPLORE_ENDPOINTS, HUB_PERSON_ENDPOINTS, HubExploreFnName, HubPersonFnName } from '@harness/sdk';
import type { z } from 'zod';
import type { HubServices } from '../boot/index.ts';
import { allRows } from '../store/rows.ts';
import { knownSystem, modelsOf, providerRecords } from './admin-ops.ts';
import { DEFAULT_AGENT } from '../chat/sessions.ts';
import { visibleRun, visibleSession, visibleTurn } from './web/access.ts';
import { maskedInstance, MAX_PAIRINGS } from './web/systems.ts';
import { injectionDeps, injectionsPage } from './injections.ts';

/** What an endpoint answers: its response schema's output, or nothing. */
type ResultOf<E> = E extends { readonly cfg: { readonly response: infer R extends z.ZodType } } ? z.output<R> : void;

/** One operation: an endpoint's parsed body and the person asking in, the endpoint's response out. */
export type PersonOp<E extends { readonly cfg: { readonly body: z.ZodType } }> = (data: z.output<E['cfg']['body']>, user: UserView) => Promise<ResultOf<E>>;

/** A person's operations, by the hub fn that offers each. */
export type PersonOperations = { readonly [N in HubPersonFnName]: PersonOp<(typeof HUB_PERSON_ENDPOINTS)[N]> };
/** The explorer's reads, by the hub fn that offers each. */
export type ExploreOperations = { readonly [N in HubExploreFnName]: PersonOp<(typeof HUB_EXPLORE_ENDPOINTS)[N]> };
/** The admin pages' reads, by the hub fn that offers each; each refuses anyone but an admin. */
export type AdminReadOperations = { readonly [N in AdminReadFnName]: PersonOp<(typeof ADMIN_READ_ENDPOINTS)[N]> };

/** Every row of a table. */
function all<T extends TableName>(hub: Pick<HubServices, 'store'>, table: T) {
  return allRows(hub.store.table(table));
}


/** A person's operations on the hub's services. */
export function personOperations(hub: HubServices): PersonOperations {
  const { chat, execution } = hub;
  return {
    session_create: async (data, user) => {
      const session = await chat.sessions.create({ ...compact(data), owner: user.id, agent: data.agent ?? DEFAULT_AGENT });
      hub.log.info('session.created', { session: session.id, user: user.id });
      return session;
    },
    session_update: async ({ session, ...patch }, user) => {
      await visibleSession(hub, session, user);
      return chat.sessions.update(session, compact(patch), user.id);
    },
    session_delete: async (data, user) => {
      await visibleSession(hub, data.session, user);
      return { deleted: await chat.sessions.delete(data.session, user.id) };
    },
    run_background: async (data, user) => {
      await visibleRun(hub, data.run, user);
      return { accepted: await execution.runs.background(data.run) };
    },
    turn_undo: async (data, user) => {
      await visibleTurn(hub, data.turn, user);
      const report = await chat.undo.undoTurn(data.turn, user.id);
      hub.log.info('turn.undone', { turn: data.turn, undone: report.undone.length, failed: report.failed.length });
      return report;
    },
    memory_update: (data, user) => hub.resources.context.update(data, { actor: user.id, admin: user.role === 'admin' }),
    ctx_link: (data, user) => hub.resources.context.link(data, { actor: user.id }),
    ctx_unlink: async (data, user) => ({ ok: await hub.resources.context.unlink(data, { actor: user.id }) }),
    access_set: (data, user) => hub.access.set(user.id, data.target, data.sharing),
    connection_update: (data, user) => hub.connections.update(user.id, data),
    connection_disconnect: async (data, user) => ({ ok: await hub.connections.disconnect(user.id, data.connection) }),
  };
}

/**
 * The explorer's reads: a system's roots, folders and files live from the instance that serves each URI, as the person
 * may see them; nothing is imported or stored in the hub. What the person may not see reads as missing.
 */
export function exploreOperations(hub: HubServices): ExploreOperations {
  const router = () => hub.link.resources;
  const seen = async (uri: string, user: UserView) => {
    const scope = await hub.access.scope(user.id);
    if (!scope.seesUri(uri)) throw reject(404, 'RESOURCE_NOT_FOUND', `no resource ${uri}`);
    return scope;
  };
  return {
    explore_roots: async (data, user) => {
      const scope = await hub.access.scope(user.id);
      if (!scope.seesSystem(data.system)) throw reject(404, 'SYSTEM_NOT_FOUND', `no system ${data.system}`);
      const instance = data.instance ?? MAIN_INSTANCE;
      return router().roots().filter((r) => r.system === data.system && r.instance === instance && scope.seesUri(r.root.uri)).map((r) => r.root);
    },
    explore_list: async (data, user) => {
      const scope = await seen(data.uri, user);
      const page = await router().list(data.uri, data.cursor);
      return { ...page, items: page.items.filter((item) => scope.seesUri(item.uri)) };
    },
    explore_read: async (data, user) => {
      await seen(data.uri, user);
      return router().read(data.uri, data.want);
    },
  };
}

/** Refuse anyone but an admin: the admin pages' reads are theirs alone. */
function needAdmin(user: UserView): void {
  if (user.role !== 'admin') throw reject(403, 'ADMIN_ONLY', 'only an admin can read this');
}

/** The admin pages' reads on the hub's services. */
export function adminReadOperations(hub: HubServices): AdminReadOperations {
  const { store } = hub;
  return {
    budgets_list: async (_data, user) => {
      needAdmin(user);
      const now = hub.clock();
      const rules = await all(hub, 'budgets');
      return Promise.all(rules.map(async (rule): Promise<BudgetView> => ({ ...rule, spent: await hub.execution.ledger.spent(rule, { now }) })));
    },
    policies_list: (_data, user) => { needAdmin(user); return all(hub, 'policies'); },
    priority_rules_list: (_data, user) => { needAdmin(user); return all(hub, 'priorityRules'); },
    providers_list: async (_data, user) => {
      needAdmin(user);
      const [records, models] = await Promise.all([providerRecords(hub), hub.execution.llm.models()]);
      return records.map((p) => ({ id: p.id, provider: p.config.provider, models: modelsOf(models, p.config.provider) }));
    },
    actors_list: async (data, user) => {
      needAdmin(user);
      return (await all(hub, 'actors')).filter((actor) => data.kind === undefined || actor.kind === data.kind);
    },
    actor_settings_list: async (_data, user) => {
      needAdmin(user);
      const declared = (await hub.catalog.entries('settings')).map((entry): SettingView => ({ setting: entry.name, system: entry.system, decl: entry.decl }));
      return { declared, values: await all(hub, 'actorSettings') };
    },
    mcps_list: (_data, user) => { needAdmin(user); return hub.mcp.registry.list(); },
    mcp_sessions_list: (data, user) => { needAdmin(user); return hub.mcp.endpoints.sessions(data.mcp); },
    pairings_list: async (data, user) => {
      needAdmin(user);
      const { status } = data;
      return (await store.table('pairings').find({ ...(status === undefined ? {} : { where: { status } }), order: [['createdAt', 'desc']], limit: MAX_PAIRINGS })).items;
    },
    auto_pairs_list: (data, user) => { needAdmin(user); return hub.link.autoPairs.list(data.system); },
    instances_list: async (data, user) => {
      needAdmin(user);
      await knownSystem(hub, data.system);
      const rows = await allRows(store.table('instances'), { where: { system: data.system } });
      return rows.sort((a, b) => a.instance.localeCompare(b.instance)).map((row) => InstanceView.parse(maskedInstance(row)));
    },
    suggest_decision_get: (_data, user) => { needAdmin(user); return hub.chat.suggestions.setting(); },
    search_decision_get: (_data, user) => { needAdmin(user); return hub.fns.decisions.settings(); },
    ctx_injections_list: async (data, user) => { needAdmin(user); return injectionsPage(injectionDeps(hub), data, user.id); },
  };
}
