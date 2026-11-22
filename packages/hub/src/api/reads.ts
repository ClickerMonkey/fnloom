/**
 * The hub's reads: the operation behind each web read the hub also offers as a `read` fn (`HUB_READ_ENDPOINTS`), given
 * the endpoint's parsed body and who is looking. The web handlers and the hub's read fns both call these, so the
 * chat LLM and the browser see the same things, and a person's fn sees only what they could see in the browser:
 * a member sees their own runs, sessions and model calls; the system logs are an admin's.
 *
 * The reads of other modules' endpoints (resources, context, model limits) are those modules' own (`resources/fns.ts`,
 * `contextor/fns.ts`); `HubReadName` is every other read fn, so a new one fails to compile until it is answered here.
 */
import { reject } from '@ayepi/core';
import { compact, QualifiedName, type ItemSection, type ModelCall, type ModelCallId, type QueryFnArgs, type QueryFnResult, type Run } from '@harness/core';
import type { HUB_READ_ENDPOINTS, HubReadFnName } from '@harness/sdk';
import type { z } from 'zod';
import type { HubServices } from '../boot/index.ts';
import type { AccessScope } from '../access/index.ts';
import { typeDefinitions } from '../catalog/definitions.ts';
import type { Where } from '../store/index.ts';
import { HubGraph } from '../graph/graph.ts';
import { HubQuery } from '../query/service.ts';
import { listSources } from '../query/sources.ts';
import { knownSystem } from './admin-ops.ts';
import { allRows, someRows } from '../store/rows.ts';
import { visibleRun, visibleSession, visibleTurn, type Viewer } from './web/access.ts';
import { buildTree } from './web/runs.ts';
import { itemVersionsPage } from '../catalog/versions.ts';
import { systemView } from './web/systems.ts';

/** The read fns other modules answer. */
export type ForeignReadName = 'resource_list' | 'resource_read' | 'ctx_get' | 'model_limits';
/** The read fns answered here. */
export type HubReadName = Exclude<HubReadFnName, ForeignReadName>;

/** What an endpoint answers: its response schema's output. */
type ResultOf<E> = E extends { readonly cfg: { readonly response: infer R extends z.ZodType } } ? z.output<R> : void;

/** One read: an endpoint's parsed body and who is looking in, the endpoint's response out. */
export type ReadOp<E extends { readonly cfg: { readonly body: z.ZodType } }> = (data: z.output<E['cfg']['body']>, who: Viewer) => Promise<ResultOf<E>>;

/** Every read answered here, by the name of the hub fn that offers it, and the one model call read (an admin's). */
export type HubReads = { readonly [N in HubReadName]: ReadOp<(typeof HUB_READ_ENDPOINTS)[N]> } & {
  modelCall(id: ModelCallId): Promise<ModelCall>;
  /** Any list by the query standard (the `query` endpoint and the hub fn `hub/query`). */
  query(data: QueryFnArgs, who: Viewer): Promise<QueryFnResult>;
  /** Every list's query, typed per list, for the list endpoints that take a `query`. */
  readonly lists: HubQuery;
};

/** How many rows a page holds when the reader doesn't say. */
const PAGE_SIZE = 50;
/** How many systems a list shows at most. */
const MAX_SYSTEMS = 500;

/** Refuse a reader who isn't an admin. */
function adminOnly(who: Viewer, what: string): void {
  if (who.role !== 'admin') { throw reject(403, 'ADMIN_ONLY', `only an admin can see ${what}`); }
}

/** Whether a person may see one item's history: a fn, type or context item by its own sharing, the rest with their system. */
async function seesItem(hub: HubServices, access: AccessScope, section: ItemSection, name: string): Promise<boolean> {
  const qualified = QualifiedName.safeParse(name);
  if (!qualified.success) { return true; }
  if (section === 'fns') { const fn = await hub.catalog.fn(qualified.data); return fn === undefined || access.seesFn(fn); }
  if (section === 'types') { const type = await hub.catalog.type(qualified.data); return type === undefined || access.seesType(type); }
  if (section === 'context') { const item = await hub.catalog.context(qualified.data); return item === undefined || access.seesContext(item); }
  return true;
}

/** The reads on the hub's services. */
export function hubReads(hub: HubServices): HubReads {
  const { store, catalog, chat } = hub;
  const lists = new HubQuery(listSources(hub, hub.settings.queryEnv));
  const graph = new HubGraph({ store, catalog, limit: hub.settings.queryEnv.HARNESS_GRAPH_LIMIT });
  return {
    lists,
    graph: async (data, who) => graph.query(data, await hub.access.scope(who.id)),
    item_versions: async (data, who) => {
      const access = await hub.access.scope(who.id);
      if (!access.seesSystem(data.system) || !await seesItem(hub, access, data.section, data.name)) { throw reject(404, 'NO_SUCH_ITEM', `no item ${data.name} of ${data.system} you can see`); }
      return itemVersionsPage(store, data);
    },
    query: (data, who) => lists.query(data, who),
    types_get: async (data, who) => {
      const access = await hub.access.scope(who.id);
      return typeDefinitions(catalog, data.names, (record) => access.seesType(record));
    },
    runs_list: async (data, who) => {
      if (data.query !== undefined) { return lists.page('runs', data.query, who); }
      // a member sees the runs they started
      const where: Where<Run> = who.role === 'admin' ? {} : { actor: who.id };
      return store.table('runs').find({ where, order: [['createdAt', 'desc']], limit: data.limit ?? PAGE_SIZE, ...(data.cursor === undefined ? {} : { cursor: data.cursor }) });
    },
    run_get: (data, who) => visibleRun(hub, data.run, who),
    run_tree: async (data, who) => {
      const turn = await visibleTurn(hub, data.turn, who);
      const [runs, calls] = await Promise.all([
        allRows(store.table('runs'), { where: { turn: turn.id }, order: [['createdAt', 'asc']] }),
        allRows(store.table('llmInteractions'), { where: { turn: turn.id }, order: [['queuedAt', 'asc']] }),
      ]);
      const tree = buildTree(turn, runs, calls);
      if (tree === undefined) { throw reject(404, 'TURN_HAS_NO_RUNS', 'nothing has run in this turn yet'); }
      return tree;
    },
    llm_call: async (data, who) => {
      const call = await store.table('llmInteractions').get(data.id);
      if (call === undefined) { throw reject(404, 'LLM_CALL_NOT_FOUND', 'no such LLM call'); }
      await visibleRun(hub, call.run, who);
      return call;
    },
    model_calls: async (data, who) => {
      if (data.query !== undefined) { return lists.page('modelCalls', data.query, who); }
      if (who.role !== 'admin') {
        // a member reads the model calls of a run or session they can see
        if (data.run !== undefined) { await visibleRun(hub, data.run, who); }
        else { throw reject(403, 'ADMIN_ONLY', 'name a run of yours to see its model calls'); }
      }
      return hub.metrics.calls.list(compact(data));
    },
    modelCall: async (id) => {
      const call = await hub.metrics.calls.get(id);
      if (call === undefined) { throw reject(404, 'MODEL_CALL_NOT_FOUND', 'no such model call'); }
      return call;
    },
    fns_metrics: (data) => hub.metrics.fns.metrics(compact(data)),
    sessions_list: (data, who) => (data.query === undefined ? chat.sessions.list(who.id, compact(data)) : lists.page('sessions', data.query, who)),
    session_messages: async ({ session, ...page }, who) => {
      await visibleSession(hub, session, who);
      return chat.sessions.messages(session, who.id, compact(page));
    },
    systems_list: async (data, who) => {
      if (data.query !== undefined) { return (await lists.page('systems', data.query, who)).items; }
      const records = await someRows(store.table('systems'), { order: [['name', 'asc']] }, MAX_SYSTEMS);
      return Promise.all(records.filter((r) => r.status !== 'removed').map((r) => systemView(hub, r)));
    },
    system_get: async (data) => systemView(hub, await knownSystem(hub, data.system)),
    system_fns: (data) => catalog.fns({ system: data.system }),
    system_logs: (data, who) => {
      adminOnly(who, 'a system\'s output');
      return Promise.resolve(hub.link.output.tail(data.system, data.limit ?? LOG_LINES));
    },
    model_roles: () => hub.models.roles.list(),
  };
}

/** How many output lines `system_logs` returns when not asked. */
export const LOG_LINES = 500;
