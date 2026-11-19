/**
 * One `ListSource` per list of `LIST_FIELDS`: how each reads its rows (bounded, narrowed to what the viewer may see
 * through the list's own endpoint), and how each field reads off a row. What the store can answer is pushed down to
 * it (exact column filters, number and date bounds on columns, a sort on number columns), so the scan bound cuts the
 * right rows. The filtering, free text, sorting and paging are the shared evaluator's (`evaluate.ts`), which applies
 * every filter again; when the scan stopped at its bound, the page says `partial`.
 */
import { reject } from '@ayepi/core';
import {
  familyOf, QualifiedName, RunStatus, SessionId, SessionSummary, SystemName, seesOrigin, runCount, sortOf, type ContextRecord, type FieldValueOption, type Filter, type FnRecord,
  type GraphNode, type ListField, type ListName, type ListQuery, type LlmInteraction, type LlmSummary, type ModelCall, type Notification, type Page, type ResourceRecord, type Run, type SystemView, type TypeRecord,
} from '@harness/core';
import type { AccessScope, AccessService } from '../access/index.ts';
import type { HubServices } from '../boot/index.ts';
import { systemView } from '../api/web/systems.ts';
import { HubGraph } from '../graph/graph.ts';
import { GraphSource } from '../graph/source.ts';
import type { ColumnFilter, Order, ScalarKey, Table, Where } from '../store/index.ts';
import { allowed, evaluate, numberOf, valuesOf, type Evaluation } from './evaluate.ts';
import type { FieldAccessors, ListSource, QueryViewer } from './index.ts';
import type { QueryEnv } from './env.ts';

/** Each list's row: the record its endpoint lists. */
export interface ListRows {
  resources: ResourceRecord;
  fns: FnRecord;
  runs: Run;
  modelCalls: ModelCall;
  llmCalls: LlmSummary;
  sessions: SessionSummary;
  contexts: ContextRecord;
  notifications: Notification;
  systems: SystemView;
  types: TypeRecord;
  graph: GraphNode;
}

/** Every list's source by name. */
export type ListSources = { readonly [L in ListName]: ListSource<L, ListRows[L]> };

/** The rows a source read, and whether the read stopped at the scan bound with more rows left unread. */
export interface Scan<Row> {
  readonly rows: readonly Row[];
  readonly partial: boolean;
}

/** How a source reads the rows a query looks at: bounded, and only what the viewer may see. */
type Load<Row> = (viewer: QueryViewer, query: ListQuery) => Promise<Scan<Row>>;

/** A source over rows it reads whole, evaluated by the shared evaluator. */
export class RowsSource<L extends ListName, Row> implements ListSource<L, Row> {
  readonly list: L;
  readonly fields: FieldAccessors<L, Row>;
  readonly #load: Load<Row>;
  readonly #how: Evaluation<L, Row>;
  readonly #page: number;

  constructor(options: { list: L; fields: FieldAccessors<L, Row>; load: Load<Row>; search?: (row: Row) => string; page: number }) {
    this.list = options.list;
    this.fields = options.fields;
    this.#load = options.load;
    this.#how = { list: options.list, fields: options.fields, search: options.search };
    this.#page = options.page;
  }

  async page(query: ListQuery, viewer: QueryViewer): Promise<Page<Row> & { total: number; partial?: true }> {
    const scan = await this.#load(viewer, query);
    return { ...evaluate(scan.rows, query, this.#how, this.#page), ...(scan.partial ? { partial: true as const } : {}) };
  }

  async values(field: ListField<L>, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]> {
    return valuesOf((await this.#load(viewer, {})).rows, this.#how, field, prefix, limit);
  }
}

/** Refuse a viewer who isn't an admin. */
function adminOnly(viewer: QueryViewer, what: string): void {
  if (viewer.role !== 'admin') { throw reject(403, 'ADMIN_ONLY', `only an admin can list ${what}`); }
}

/** A column filter from allowed values: one value as itself, several as `in`. */
function oneOf<V>(values: readonly V[] | undefined): V | { in: readonly V[] } | undefined {
  if (values === undefined) { return undefined; }
  return values.length === 1 && values[0] !== undefined ? values[0] : { in: values };
}

/** The `system` and `session` filters of a call list, pushed down to the store so the scan bound doesn't cut them. */
function pushed(query: ListQuery): { system?: SystemName | { in: readonly SystemName[] }; session?: SessionId | { in: readonly SessionId[] } } {
  const system = oneOf(allowed(query.filters, 'system', SystemName));
  const session = oneOf(allowed(query.filters, 'session', SessionId));
  return { ...(system === undefined ? {} : { system }), ...(session === undefined ? {} : { session }) };
}

/**
 * A number or date filter on a field as a store bound on its column: the first `gt`, `gte`, `lt`, `lte` or `between`
 * (its lower end) whose value reads as a number. The bound only narrows what the evaluator would keep anyway; the
 * evaluator still applies every filter. Use it only for a field whose reading is its column's own number.
 */
export function bound(filters: readonly Filter[] | undefined, field: string): ColumnFilter<number> | undefined {
  for (const filter of filters ?? []) {
    if (filter.field !== field) { continue; }
    const found = boundOf(filter);
    if (found !== undefined) { return found; }
  }
  return undefined;
}

/** One filter as a column bound, or nothing when its op is not a bound or its value is not a number. */
function boundOf(filter: Filter): ColumnFilter<number> | undefined {
  switch (filter.op) {
    case 'between': { const value = numberOf(filter.from); return value === undefined ? undefined : { gte: value }; }
    case 'gt': { const value = numberOf(filter.value); return value === undefined ? undefined : { gt: value }; }
    case 'gte': { const value = numberOf(filter.value); return value === undefined ? undefined : { gte: value }; }
    case 'lt': { const value = numberOf(filter.value); return value === undefined ? undefined : { lt: value }; }
    case 'lte': { const value = numberOf(filter.value); return value === undefined ? undefined : { lte: value }; }
    case 'is': case 'isNot': case 'contains': case 'in': case 'notIn': case 'empty': case 'notEmpty': return undefined;
  }
}

/** One column filter to spread into a where, or nothing when there is no filter. */
function column<K extends string, V>(key: K, filter: V | undefined): { [P in K]?: V } {
  const out: { [P in K]?: V } = {};
  if (filter !== undefined) { out[key] = filter; }
  return out;
}

/** The columns of a row whose values are numbers (dates are numbers too): the ones a sort can be pushed down on. */
type NumberKey<Row> = Extract<{ [K in ScalarKey<Row>]-?: Exclude<Row[K], undefined> extends number ? K : never }[ScalarKey<Row>], ScalarKey<Row>>;

/**
 * The order to scan in: the query's sort (`sortOf`) when every key is a number column, which orders the same in the
 * store and in the evaluator (absent first ascending), so the bound keeps the rows that sort first; else the fallback.
 */
function scanOrder<L extends ListName, Row>(list: L, query: ListQuery, columns: { readonly [F in ListField<L>]?: NumberKey<Row> }, fallback: Order<Row>): Order<Row> {
  const named: Readonly<Record<string, NumberKey<Row> | undefined>> = columns;
  const out: Array<readonly [ScalarKey<Row>, 'asc' | 'desc']> = [];
  for (const key of sortOf(list, query)) {
    const name = named[key.field];
    if (name === undefined) { return fallback; }
    out.push([name, key.dir]);
  }
  return out.length === 0 ? fallback : out;
}

/** Read the rows a where matches in an order, up to the scan bound, saying whether rows were left unread. */
async function newest<Row, Key>(table: Table<Row, Key>, where: Where<Row>, order: Order<Row>, max: number): Promise<Scan<Row>> {
  const out: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await table.find({ where, order, limit: Math.min(500, max - out.length), ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined && out.length < max);
  return { rows: out, partial: cursor !== undefined };
}

/** A scan's rows changed by a function, keeping whether it was partial. */
async function mapped<Row, Out>(scan: Promise<Scan<Row>>, change: (rows: readonly Row[]) => Out[] | Promise<Out[]>): Promise<Scan<Out>> {
  const read = await scan;
  return { rows: await change(read.rows), partial: read.partial };
}

/** A span in milliseconds, when both ends are known. */
function span(from: number | undefined, to: number | undefined): number | undefined {
  return from === undefined || to === undefined ? undefined : Math.max(0, to - from);
}

/** The tokens a model call used, where its modality counts them. */
function callTokens(call: ModelCall): number | undefined {
  const units = call.units;
  switch (units.modality) {
    case 'chat': return units.input + units.output;
    case 'embed': return units.tokens;
    case 'image': case 'transcribe': case 'speech': return undefined;
  }
}

/** Every list's source over the hub's services. */
export function listSources(hub: Pick<HubServices, 'store' | 'catalog'> & { readonly access: Pick<AccessService, 'scope'> }, settings: QueryEnv): ListSources {
  const { store } = hub;
  /** The rows of a scan the viewer may see, by the access scope made for them. */
  const seen = async <Row>(viewer: QueryViewer, scan: Promise<Scan<Row>>, sees: (access: AccessScope, row: Row) => boolean): Promise<Scan<Row>> => {
    const [access, read] = await Promise.all([hub.access.scope(viewer.id), scan]);
    return { ...read, rows: read.rows.filter((row) => sees(access, row)) };
  };
  const max = settings.HARNESS_QUERY_SCAN;
  const page = settings.HARNESS_QUERY_PAGE;
  /** The sessions a viewer owns (a member's model calls are those of their sessions), and whether the read was cut. */
  const ownSessions = (viewer: QueryViewer): Promise<Scan<SessionId>> =>
    mapped(newest(store.table('sessions'), { owner: viewer.id }, [['updatedAt', 'desc']], max), (rows) => rows.map((s) => s.id));

  return {
    resources: new RowsSource({
      list: 'resources', page,
      load: (viewer, query) => seen(viewer, newest(
        store.table('resources'),
        { ...column('system', oneOf(allowed(query.filters, 'system', SystemName))), ...column('seenAt', bound(query.filters, 'seenAt')) },
        scanOrder('resources', query, { seenAt: 'seenAt' }, [['seenAt', 'desc']]), max,
      ), (access, row) => access.seesUri(row.uri)),
      search: (r) => r.uri,
      fields: {
        name: (r) => r.stat.name, system: (r) => r.system, family: (r) => familyOf(r.stat.format, r.stat.mime), source: (r) => r.source?.from ?? 'system',
        forms: (r) => r.forms ?? [], size: (r) => r.stat.size, seenAt: (r) => r.seenAt, modifiedAt: (r) => r.stat.modifiedAt,
      },
    }),
    fns: new RowsSource({
      list: 'fns', page,
      load: async (viewer, query) => {
        adminOnly(viewer, 'fns');
        const where: Where<FnRecord> = { ...column('system', oneOf(allowed(query.filters, 'system', SystemName))), ...column('updatedAt', bound(query.filters, 'updatedAt')) };
        return newest(store.table('fns'), where, scanOrder('fns', query, { updatedAt: 'updatedAt' }, [['name', 'asc']]), max);
      },
      search: (f) => f.decl.description,
      fields: {
        name: (f) => f.name, system: (f) => f.system, kind: (f) => f.decl.kind, available: (f) => f.available === true, paused: (f) => f.paused,
        disabled: (f) => f.disabled, runs: (f) => runCount(f.stats.outcomes), failures: (f) => f.stats.outcomes.failed + f.stats.outcomes['invalid-input'],
        averageCost: (f) => f.stats.averageCost, averageTime: (f) => f.stats.averageTime, lastRunAt: (f) => f.stats.lastRunAt, updatedAt: (f) => f.updatedAt,
      },
    }),
    runs: new RowsSource({
      list: 'runs', page,
      load: async (viewer, query) => {
        const { filters } = query;
        const where: Where<Run> = {
          ...column('status', oneOf(allowed(filters, 'status', RunStatus))), ...column('system', oneOf(allowed(filters, 'system', SystemName))),
          ...column('fn', oneOf(allowed(filters, 'fn', QualifiedName))), ...column('session', oneOf(allowed(filters, 'session', SessionId))),
          ...column('cost', bound(filters, 'cost')), ...column('createdAt', bound(filters, 'createdAt')), ...column('endedAt', bound(filters, 'endedAt')),
          // a member sees the runs they started
          ...(viewer.role === 'admin' ? {} : { actor: viewer.id }),
        };
        return newest(store.table('runs'), where, scanOrder('runs', query, { cost: 'cost', createdAt: 'createdAt', endedAt: 'endedAt' }, [['createdAt', 'desc']]), max);
      },
      search: (r) => r.id,
      fields: {
        fn: (r) => r.fn, system: (r) => r.system, status: (r) => r.status, session: (r) => r.session, actor: (r) => r.actor, cost: (r) => r.cost,
        duration: (r) => span(r.startedAt ?? r.createdAt, r.endedAt), createdAt: (r) => r.createdAt, endedAt: (r) => r.endedAt,
      },
    }),
    modelCalls: new RowsSource({
      list: 'modelCalls', page,
      load: async (viewer, query) => {
        const { filters } = query;
        const where: Where<ModelCall> = {
          ...pushed(query),
          ...column('cost', bound(filters, 'cost')), ...column('startedAt', bound(filters, 'createdAt')), ...column('total', bound(filters, 'duration')),
        };
        const order = scanOrder<'modelCalls', ModelCall>('modelCalls', query, { cost: 'cost', createdAt: 'startedAt', duration: 'total' }, [['startedAt', 'desc']]);
        if (viewer.role === 'admin') { return newest(store.table('modelCalls'), where, order, max); }
        // a member sees the model calls of their own sessions: those sessions (within any session filter) go to the store
        const mine = await ownSessions(viewer);
        const asked = allowed(filters, 'session', SessionId);
        const sessions = asked === undefined ? mine.rows : mine.rows.filter((id) => asked.includes(id));
        const calls = await newest(store.table('modelCalls'), { ...where, session: { in: sessions } }, order, max);
        return { rows: calls.rows, partial: calls.partial || mine.partial };
      },
      search: (c) => `${c.fn ?? ''} ${c.purpose ?? ''}`,
      fields: {
        modality: (c) => c.modality, model: (c) => c.model, provider: (c) => c.provider, system: (c) => c.system, status: (c) => c.status, session: (c) => c.session,
        cost: (c) => c.cost, tokens: callTokens, duration: (c) => c.total, createdAt: (c) => c.startedAt,
      },
    }),
    llmCalls: new RowsSource({
      list: 'llmCalls', page,
      load: async (viewer, query) => {
        adminOnly(viewer, 'LLM calls');
        const where = { ...pushed(query), ...column('cost', bound(query.filters, 'cost')), ...column('queuedAt', bound(query.filters, 'createdAt')) };
        const order = scanOrder<'llmCalls', LlmInteraction>('llmCalls', query, { cost: 'cost', createdAt: 'queuedAt' }, [['queuedAt', 'desc']]);
        return mapped(newest(store.table('llmInteractions'), where, order, max), (rows) => rows.map(({ request: _request, response: _response, ...summary }): LlmSummary => summary));
      },
      fields: {
        model: (c) => c.model, system: (c) => c.system, status: (c) => c.status, session: (c) => c.session, cost: (c) => c.cost,
        tokens: (c) => (c.usage === undefined ? undefined : c.usage.input + c.usage.output), duration: (c) => span(c.startedAt ?? c.queuedAt, c.endedAt),
        createdAt: (c) => c.queuedAt,
      },
    }),
    sessions: new RowsSource({
      list: 'sessions', page,
      load: (viewer, query) => mapped(newest(
        store.table('sessions'),
        { owner: viewer.id, ...column('createdAt', bound(query.filters, 'createdAt')), ...column('updatedAt', bound(query.filters, 'updatedAt')) },
        scanOrder('sessions', query, { createdAt: 'createdAt', updatedAt: 'updatedAt' }, [['updatedAt', 'desc']]), max,
      ), (rows) => rows.map((s) => SessionSummary.parse(s))),
      fields: {
        title: (s) => s.title, agent: (s) => s.agent, status: (s) => s.status, archived: (s) => s.archived, createdAt: (s) => s.createdAt, updatedAt: (s) => s.updatedAt,
      },
    }),
    contexts: new RowsSource({
      list: 'contexts', page,
      load: (viewer, query) => seen(viewer, newest(
        store.table('context'),
        { ...column('system', oneOf(allowed(query.filters, 'system', SystemName))), ...column('updatedAt', bound(query.filters, 'updatedAt')) },
        scanOrder('contexts', query, { updatedAt: 'updatedAt' }, [['updatedAt', 'desc']]), max,
      ), (access, record) => seesOrigin(record.origin, { actor: viewer.id }) && access.seesContext(record)),
      search: (c) => c.decl.description,
      fields: {
        name: (c) => c.name, system: (c) => c.system, origin: (c) => c.origin?.type ?? 'system', tags: (c) => c.decl.tags, disabled: (c) => c.disabled === true,
        stale: (c) => c.stale, tokens: (c) => c.tokens?.full, updatedAt: (c) => c.updatedAt,
      },
    }),
    notifications: new RowsSource({
      list: 'notifications', page,
      load: (viewer, query) => newest(
        store.table('notifications'), { user: viewer.id, ...column('createdAt', bound(query.filters, 'createdAt')) },
        scanOrder('notifications', query, { createdAt: 'createdAt' }, [['createdAt', 'desc']]), max,
      ),
      search: (n) => `${n.title} ${n.body}`,
      fields: { kind: (n) => n.reason, read: (n) => n.read, createdAt: (n) => n.createdAt },
    }),
    systems: new RowsSource({
      list: 'systems', page,
      load: (viewer) => {
        adminOnly(viewer, 'systems');
        return mapped(newest(store.table('systems'), {}, [['name', 'asc']], max), (records) => Promise.all(records.filter((r) => r.status !== 'removed').map((r) => systemView(hub, r))));
      },
      fields: {
        name: (s) => s.name, status: (s) => s.status, version: (s) => s.version, instances: (s) => s.counts.instances, fns: (s) => s.counts.fns,
        context: (s) => s.counts.context, types: (s) => s.counts.types, parts: (s) => s.counts.parts, pending: (s) => s.counts.pending, refusals: (s) => s.counts.refusals,
        lastSeenAt: (s) => s.lastSeenAt,
      },
    }),
    // a type is listed to whoever sees it: its system, and its audience when it has one (a database's table types)
    types: new RowsSource({
      list: 'types', page,
      load: (viewer, query) => seen(viewer, newest(store.table('types'), column('system', oneOf(allowed(query.filters, 'system', SystemName))), [['name', 'asc']], max), (access, row) => access.seesType(row)),
      search: (t) => t.description,
      fields: {
        name: (t) => t.name, system: (t) => t.system, instance: (t) => t.instance, references: (t) => t.references.length, updatedAt: (t) => t.updatedAt,
      },
    }),
    // the graph's nodes, as the viewer may see them: the graph builds them for the query's text and filters
    graph: new GraphSource({ graph: new HubGraph({ store, catalog: hub.catalog, limit: settings.HARNESS_GRAPH_LIMIT }), access: hub.access, page }),
  };
}
