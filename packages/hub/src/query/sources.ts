/**
 * One `ListSource` per list of `LIST_FIELDS`: how each reads its rows (bounded, narrowed to what the viewer may see
 * through the list's own endpoint, with exact column filters pushed down to the store), and how each field reads off a
 * row. The filtering, free text, sorting and paging are the shared evaluator's (`evaluate.ts`).
 */
import { reject } from '@ayepi/core';
import {
  familyOf, RunStatus, SessionSummary, SystemName, seesOrigin, runCount, type ContextRecord, type FieldValueOption, type Filter, type FnRecord, type ListField, type ListName,
  type ListQuery, type LlmSummary, type ModelCall, type Notification, type Page, type ResourceRecord, type Run, type SystemView,
} from '@harness/core';
import type { z } from 'zod';
import type { HubServices } from '../boot/index.ts';
import { systemView } from '../api/web/systems.ts';
import type { Table, Where } from '../store/index.ts';
import { evaluate, valuesOf, type Evaluation } from './evaluate.ts';
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
}

/** Every list's source by name. */
export type ListSources = { readonly [L in ListName]: ListSource<L, ListRows[L]> };

/** How a source reads the rows a query looks at: bounded, and only what the viewer may see. */
type Load<Row> = (viewer: QueryViewer, query: ListQuery) => Promise<readonly Row[]>;

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

  async page(query: ListQuery, viewer: QueryViewer): Promise<Page<Row> & { total: number }> {
    return evaluate(await this.#load(viewer, query), query, this.#how, this.#page);
  }

  async values(field: ListField<L>, prefix: string | undefined, limit: number, viewer: QueryViewer): Promise<FieldValueOption[]> {
    return valuesOf(await this.#load(viewer, {}), this.#how, field, prefix, limit);
  }
}

/** Refuse a viewer who isn't an admin. */
function adminOnly(viewer: QueryViewer, what: string): void {
  if (viewer.role !== 'admin') { throw reject(403, 'ADMIN_ONLY', `only an admin can list ${what}`); }
}

/**
 * The values an `is` or `in` filter on a field allows, read through the column's schema (undefined when the query
 * has no such filter, or one whose values the column can't hold, which the evaluator then settles).
 */
export function allowed<S extends z.ZodType>(filters: readonly Filter[] | undefined, field: string, schema: S): Array<z.output<S>> | undefined {
  for (const filter of filters ?? []) {
    if (filter.field !== field) { continue; }
    const values = filter.op === 'is' ? [filter.value] : filter.op === 'in' ? filter.values : undefined;
    if (values === undefined) { continue; }
    const parsed = schema.array().safeParse(values);
    if (parsed.success) { return parsed.data; }
  }
  return undefined;
}

/** A column filter from allowed values: one value as itself, several as `in`. */
function oneOf<V>(values: readonly V[] | undefined): V | { in: readonly V[] } | undefined {
  if (values === undefined) { return undefined; }
  return values.length === 1 && values[0] !== undefined ? values[0] : { in: values };
}

/** Read the newest rows a where matches, up to the scan bound. */
async function newest<Row, Key>(table: Table<Row, Key>, where: Where<Row>, order: NonNullable<Parameters<Table<Row, Key>['find']>[0]['order']>, max: number): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await table.find({ where, order, limit: Math.min(500, max - out.length), ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined && out.length < max);
  return out;
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
export function listSources(hub: Pick<HubServices, 'store' | 'catalog'>, settings: QueryEnv): ListSources {
  const { store } = hub;
  const max = settings.HARNESS_QUERY_SCAN;
  const page = settings.HARNESS_QUERY_PAGE;
  /** The ids of the sessions a viewer owns (a member's model calls are those of their sessions). */
  const ownSessions = async (viewer: QueryViewer): Promise<Set<string>> =>
    new Set((await newest(store.table('sessions'), { owner: viewer.id }, [['updatedAt', 'desc']], max)).map((s) => s.id));

  return {
    resources: new RowsSource({
      list: 'resources', page,
      load: async (_viewer, query) => {
        const system = oneOf(allowed(query.filters, 'system', SystemName));
        return newest(store.table('resources'), system === undefined ? {} : { system }, [['seenAt', 'desc']], max);
      },
      search: (r) => r.uri,
      fields: {
        name: (r) => r.stat.name, system: (r) => r.system, family: (r) => familyOf(r.stat.format, r.stat.mime), source: (r) => r.source?.from ?? 'system',
        size: (r) => r.stat.size, seenAt: (r) => r.seenAt, modifiedAt: (r) => r.stat.modifiedAt,
      },
    }),
    fns: new RowsSource({
      list: 'fns', page,
      load: async (viewer, query) => {
        adminOnly(viewer, 'fns');
        const system = oneOf(allowed(query.filters, 'system', SystemName));
        return newest(store.table('fns'), system === undefined ? {} : { system }, [['name', 'asc']], max);
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
        const status = oneOf(allowed(query.filters, 'status', RunStatus));
        const system = oneOf(allowed(query.filters, 'system', SystemName));
        const where: Where<Run> = {
          ...(status === undefined ? {} : { status }), ...(system === undefined ? {} : { system }),
          // a member sees the runs they started
          ...(viewer.role === 'admin' ? {} : { actor: viewer.id }),
        };
        return newest(store.table('runs'), where, [['createdAt', 'desc']], max);
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
        const system = oneOf(allowed(query.filters, 'system', SystemName));
        const rows = await newest(store.table('modelCalls'), system === undefined ? {} : { system }, [['startedAt', 'desc']], max);
        if (viewer.role === 'admin') { return rows; }
        // a member sees the model calls of their own sessions
        const mine = await ownSessions(viewer);
        return rows.filter((call) => call.session !== undefined && mine.has(call.session));
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
        const system = oneOf(allowed(query.filters, 'system', SystemName));
        const rows = await newest(store.table('llmInteractions'), system === undefined ? {} : { system }, [['queuedAt', 'desc']], max);
        return rows.map(({ request: _request, response: _response, ...summary }): LlmSummary => summary);
      },
      fields: {
        model: (c) => c.model, system: (c) => c.system, status: (c) => c.status, session: (c) => c.session, cost: (c) => c.cost,
        tokens: (c) => (c.usage === undefined ? undefined : c.usage.input + c.usage.output), duration: (c) => span(c.startedAt ?? c.queuedAt, c.endedAt),
        createdAt: (c) => c.queuedAt,
      },
    }),
    sessions: new RowsSource({
      list: 'sessions', page,
      load: async (viewer) => (await newest(store.table('sessions'), { owner: viewer.id }, [['updatedAt', 'desc']], max)).map((s) => SessionSummary.parse(s)),
      fields: {
        title: (s) => s.title, agent: (s) => s.agent, status: (s) => s.status, archived: (s) => s.archived, createdAt: (s) => s.createdAt, updatedAt: (s) => s.updatedAt,
      },
    }),
    contexts: new RowsSource({
      list: 'contexts', page,
      load: async (viewer, query) => {
        const system = oneOf(allowed(query.filters, 'system', SystemName));
        const rows = await newest(store.table('context'), system === undefined ? {} : { system }, [['updatedAt', 'desc']], max);
        return rows.filter((record) => seesOrigin(record.origin, { actor: viewer.id }));
      },
      search: (c) => c.decl.description,
      fields: {
        name: (c) => c.name, system: (c) => c.system, origin: (c) => c.origin?.type ?? 'system', tags: (c) => c.decl.tags, disabled: (c) => c.disabled === true,
        stale: (c) => c.stale, tokens: (c) => c.tokens?.full, updatedAt: (c) => c.updatedAt,
      },
    }),
    notifications: new RowsSource({
      list: 'notifications', page,
      load: (viewer) => newest(store.table('notifications'), { user: viewer.id }, [['createdAt', 'desc']], max),
      search: (n) => `${n.title} ${n.body}`,
      fields: { kind: (n) => n.reason, read: (n) => n.read, createdAt: (n) => n.createdAt },
    }),
    systems: new RowsSource({
      list: 'systems', page,
      load: async (viewer) => {
        adminOnly(viewer, 'systems');
        const records = await newest(store.table('systems'), {}, [['name', 'asc']], max);
        return Promise.all(records.filter((r) => r.status !== 'removed').map((r) => systemView(hub, r)));
      },
      fields: {
        name: (s) => s.name, status: (s) => s.status, version: (s) => s.version, instances: (s) => s.instances.length, fns: (s) => s.fns,
        lastSeenAt: (s) => s.lastSeenAt,
      },
    }),
  };
}
