/**
 * The query standard (build 3): one filter and sort model for every list the hub serves (resources, fns, runs, model
 * calls, LLM calls, sessions, context, notifications, systems). Each list declares its fields once here, in
 * `LIST_FIELDS`; the hub filters, sorts and pages server side by that declaration (and refuses a query that breaks it,
 * with `queryProblems`); the web app's search box builds its filter menu and pills from it; and the hub fn
 * `hub/query` takes the same `ListQuery`, so the chat LLM sees exactly what a person does.
 */
import { z } from 'zod';
import { PageRequest, page } from './primitives.ts';
import { RUN_STATUSES } from './run.ts';
import { CONTEXT_ORIGIN_TYPES } from './context-graph.ts';
import { RESOURCE_SOURCES, FORMAT_FAMILIES } from './resource-forms.ts';
import { MODALITIES, ModelCallStatus } from './model-calls.ts';
import { LlmStatus } from './records/runs.ts';
import { FormKind } from './resources.ts';

// ─── Fields and operators ─────────────────────────────────────────────────────

/** What a field holds. `date` values are `Timestamp`s (ms since the epoch). */
export const FIELD_TYPES = ['text', 'enum', 'number', 'date', 'boolean'] as const;
export const FieldType = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldType>;

/** Every filter operator. Which apply to a field follows from its type (`OPS_BY_TYPE`). */
export const FILTER_OPS = ['is', 'isNot', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty', 'contains'] as const;
export const FilterOp = z.enum(FILTER_OPS);
export type FilterOp = z.infer<typeof FilterOp>;

/** The operators each field type takes, in the order the filter menu offers them. */
export const OPS_BY_TYPE = {
  text: ['contains', 'is', 'isNot', 'in', 'notIn', 'empty', 'notEmpty'],
  enum: ['is', 'isNot', 'in', 'notIn', 'empty', 'notEmpty'],
  number: ['gt', 'gte', 'lt', 'lte', 'between', 'is', 'isNot', 'empty', 'notEmpty'],
  date: ['gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'],
  boolean: ['is'],
} as const satisfies Record<FieldType, readonly FilterOp[]>;

/** How an operator reads in a pill (`Cost > 0.01`, `Status in Running, Queued`). */
export const OP_LABELS = {
  is: 'is', isNot: 'is not', in: 'in', notIn: 'not in', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
  empty: 'is empty', notEmpty: 'is not empty', contains: 'contains',
} as const satisfies Record<FilterOp, string>;

/** A value a filter compares with: text (also enum values), a number (also dates), or a boolean. */
export const FilterValue = z.union([z.string(), z.number(), z.boolean()]);
export type FilterValue = z.infer<typeof FilterValue>;

/** The unit a number field is shown in, so pills and values read right (`$0.00042`, `1.2 s`). */
export const FieldUnit = z.enum(['usd', 'ms', 'tokens', 'bytes', 'count']);
export type FieldUnit = z.infer<typeof FieldUnit>;

/**
 * One filterable or sortable field of a list. `values` lists an enum's fixed values; `dynamic` says its values come
 * from the data (system names, models), offered by the `listValues` endpoint as the person types.
 */
export const FieldDecl = z.object({
  label: z.string(),
  type: FieldType,
  sortable: z.boolean(),
  filterable: z.boolean(),
  values: z.array(z.string()).readonly().optional(),
  dynamic: z.boolean().optional(),
  unit: FieldUnit.optional(),
});
export type FieldDecl = z.infer<typeof FieldDecl>;

// ─── The query ────────────────────────────────────────────────────────────────

const FieldKey = z.string().min(1);

/** One filter: a field, an operator, and the value(s) its operator needs. */
export const Filter = z.discriminatedUnion('op', [
  z.object({ field: FieldKey, op: z.enum(['is', 'isNot', 'gt', 'gte', 'lt', 'lte', 'contains']), value: FilterValue }),
  z.object({ field: FieldKey, op: z.enum(['in', 'notIn']), values: z.array(FilterValue).min(1) }),
  z.object({ field: FieldKey, op: z.literal('between'), from: FilterValue, to: FilterValue }),
  z.object({ field: FieldKey, op: z.enum(['empty', 'notEmpty']) }),
]);
export type Filter = z.infer<typeof Filter>;

export const SortDir = z.enum(['asc', 'desc']);
export type SortDir = z.infer<typeof SortDir>;

/** One sort key. Several are applied in order; the list's `defaultSort` applies when none is given. */
export const Sort = z.object({ field: FieldKey, dir: SortDir });
export type Sort = z.infer<typeof Sort>;

/**
 * A query over one list: free text (plain matching over the list's text fields), filters (all must hold), sort keys
 * and a page. The same shape is every list endpoint's `query` and `hub/query`'s.
 */
export const ListQuery = PageRequest.extend({
  text: z.string().optional(),
  filters: z.array(Filter).max(20).optional(),
  sort: z.array(Sort).max(3).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

// ─── The lists ────────────────────────────────────────────────────────────────

const text = (label: string, extra: Partial<FieldDecl> = {}): FieldDecl => ({ label, type: 'text', sortable: true, filterable: true, ...extra });
const choice = (label: string, values: readonly string[]): FieldDecl => ({ label, type: 'enum', sortable: true, filterable: true, values });
const dynamic = (label: string): FieldDecl => ({ label, type: 'enum', sortable: true, filterable: true, dynamic: true });
const num = (label: string, unit: FieldUnit): FieldDecl => ({ label, type: 'number', sortable: true, filterable: true, unit });
const date = (label: string): FieldDecl => ({ label, type: 'date', sortable: true, filterable: true });
const flag = (label: string): FieldDecl => ({ label, type: 'boolean', sortable: false, filterable: true });

/** The queryable lists. */
export const LIST_NAMES = ['resources', 'fns', 'runs', 'modelCalls', 'llmCalls', 'sessions', 'contexts', 'notifications', 'systems'] as const;
export const ListName = z.enum(LIST_NAMES);
export type ListName = z.infer<typeof ListName>;

/**
 * Every queryable list's fields and default sort. The hub maps each field key to its rows (a
 * `Record<ListField<L>, ...>` per list, so a key added here fails to compile in the hub until it is served).
 */
export const LIST_FIELDS = {
  resources: {
    fields: {
      name: text('Name'), system: dynamic('System'), family: choice('Type', FORMAT_FAMILIES), source: choice('Source', RESOURCE_SOURCES),
      forms: { ...choice('Forms', FormKind.options), sortable: false }, size: num('Size', 'bytes'), seenAt: date('Seen'), modifiedAt: date('Modified'),
    },
    defaultSort: [{ field: 'seenAt', dir: 'desc' }],
  },
  fns: {
    fields: {
      name: text('Name'), system: dynamic('System'), kind: dynamic('Kind'), available: flag('Available'), paused: flag('Paused'), disabled: flag('Disabled'),
      runs: num('Runs', 'count'), failures: num('Failures', 'count'), averageCost: num('Avg cost', 'usd'), averageTime: num('Avg time', 'ms'),
      lastRunAt: date('Last run'), updatedAt: date('Updated'),
    },
    defaultSort: [{ field: 'name', dir: 'asc' }],
  },
  runs: {
    fields: {
      fn: dynamic('Fn'), system: dynamic('System'), status: choice('Status', RUN_STATUSES), session: dynamic('Session'), actor: dynamic('By'),
      cost: num('Cost', 'usd'), duration: num('Duration', 'ms'), createdAt: date('Started'), endedAt: date('Ended'),
    },
    defaultSort: [{ field: 'createdAt', dir: 'desc' }],
  },
  modelCalls: {
    fields: {
      modality: choice('Modality', MODALITIES), model: dynamic('Model'), provider: dynamic('Provider'), system: dynamic('System'),
      status: choice('Status', ModelCallStatus.options), session: dynamic('Session'), cost: num('Cost', 'usd'), tokens: num('Tokens', 'tokens'),
      duration: num('Duration', 'ms'), createdAt: date('Started'),
    },
    defaultSort: [{ field: 'createdAt', dir: 'desc' }],
  },
  llmCalls: {
    fields: {
      model: dynamic('Model'), system: dynamic('System'), status: choice('Status', LlmStatus.options), session: dynamic('Session'),
      cost: num('Cost', 'usd'), tokens: num('Tokens', 'tokens'), duration: num('Duration', 'ms'), createdAt: date('Started'),
    },
    defaultSort: [{ field: 'createdAt', dir: 'desc' }],
  },
  sessions: {
    fields: { title: text('Title'), agent: dynamic('Agent'), status: choice('Status', ['idle', 'running', 'paused']), archived: flag('Archived'), createdAt: date('Created'), updatedAt: date('Updated') },
    defaultSort: [{ field: 'updatedAt', dir: 'desc' }],
  },
  contexts: {
    fields: {
      name: text('Name'), system: dynamic('System'), origin: choice('Origin', CONTEXT_ORIGIN_TYPES), tags: dynamic('Tag'), disabled: flag('Off'),
      stale: flag('Stale'), tokens: num('Tokens', 'tokens'), updatedAt: date('Updated'),
    },
    defaultSort: [{ field: 'updatedAt', dir: 'desc' }],
  },
  notifications: {
    fields: { kind: dynamic('Kind'), read: flag('Read'), createdAt: date('Received') },
    defaultSort: [{ field: 'createdAt', dir: 'desc' }],
  },
  systems: {
    fields: { name: text('Name'), status: dynamic('Status'), version: text('Version'), instances: num('Instances', 'count'), fns: num('Fns', 'count'), lastSeenAt: date('Last seen') },
    defaultSort: [{ field: 'name', dir: 'asc' }],
  },
} as const satisfies Record<ListName, { fields: Record<string, FieldDecl>; defaultSort: readonly Sort[] }>;

/** A list's field keys. */
export type ListField<L extends ListName> = keyof (typeof LIST_FIELDS)[L]['fields'] & string;

/** The declaration of one field of a list, or undefined for a key the list doesn't have. */
export function fieldOf(list: ListName, field: string): FieldDecl | undefined {
  const fields: Record<string, FieldDecl> = LIST_FIELDS[list].fields;
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
}

/** The sort a query gets: its own, else its list's default. The list UI always shows this. */
export function sortOf(list: ListName, query: ListQuery): readonly Sort[] {
  return query.sort !== undefined && query.sort.length > 0 ? query.sort : LIST_FIELDS[list].defaultSort;
}

/** What is wrong with a query for a list, in words (empty when it is fine). The hub refuses a query with problems. */
export function queryProblems(list: ListName, query: ListQuery): string[] {
  const problems: string[] = [];
  for (const filter of query.filters ?? []) {
    const decl = fieldOf(list, filter.field);
    if (decl === undefined || !decl.filterable) { problems.push(`${list} has no filterable field "${filter.field}".`); continue; }
    const ops: readonly FilterOp[] = OPS_BY_TYPE[decl.type];
    if (!ops.includes(filter.op)) { problems.push(`${decl.label} does not take "${OP_LABELS[filter.op]}".`); }
  }
  for (const sort of query.sort ?? []) {
    const decl = fieldOf(list, sort.field);
    if (decl === undefined || !decl.sortable) { problems.push(`${list} cannot be sorted by "${sort.field}".`); }
  }
  return problems;
}

// ─── Endpoint shapes ──────────────────────────────────────────────────────────

/** A value a field takes in the data, with how many rows have it: what the search box suggests as you type. */
export const FieldValueOption = z.object({ value: FilterValue, label: z.string().optional(), count: z.number().int().min(0) });
export type FieldValueOption = z.infer<typeof FieldValueOption>;

/** `listValues`: a field's values matching what is typed (all of a dynamic enum's, best first). */
export const ListValuesQuery = z.object({ list: ListName, field: FieldKey, prefix: z.string().optional(), limit: z.number().int().min(1).max(50).optional() });
export type ListValuesQuery = z.infer<typeof ListValuesQuery>;

/** `hub/query`: the LLM's way into any list, with the same query a person uses. */
export const QueryFnArgs = z.object({ list: ListName, query: ListQuery.default({}) });
export type QueryFnArgs = z.infer<typeof QueryFnArgs>;

/** What `hub/query` returns: the rows as JSON (each list's record), the sort applied, and the next page's cursor. */
export const QueryFnResult = page(z.json()).extend({ sort: z.array(Sort), total: z.number().int().min(0).optional() });
export type QueryFnResult = z.infer<typeof QueryFnResult>;
