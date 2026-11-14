/**
 * The query authoring agent behind `get_query` and `edit_query`, on the SDK's `authoringAgent` (product's query agent,
 * ported): the chat model only describes what it wants; this agent works through a forced workflow on `ctx.ai()` and
 * the chat gets back the saved fn and its run, never the working context.
 *
 * - **find:** `find_queries` searches the saved queries of this database (the hub's search) and lists its tables by
 *   name; `use_saved` answers with a saved query that already does it.
 * - **inspect (progressive disclosure):** `load_tables` shows only the tables asked for, `load_query` one saved
 *   query's JSON, and `query_syntax` the expressions, functions and worked examples for the loaded tables.
 * - **draft → check → fix:** the draft's `query` arg is `@aeye/query`'s typed schema (`buildSchemas`) over the loaded
 *   tables, so the model writes against the real types; each draft is checked (it compiles, a write only where writes
 *   are allowed, the args for this request fit its signature) and a clean read shows its first rows.
 * - **save:** the clean draft is kept in the hub as a `database/query` fn of this instance (a new version when editing).
 */
import { buildSchemas, describeExprs, describeFunctions, describeQueryExamples, describeTypes, type Type } from '@aeye/query';
import { Json, type FnSearchPage, type FnSearchQuery } from '@harness/core';
import { authoringAgent, authoringTool, type AuthoredFn, type AuthoringSession } from '@harness/sdk/server';
import { z } from 'zod';
import { ParamValues, QueryDraft, QueryPayload, type QueryHow } from '../shared/shapes.ts';
import { QUERY_KIND } from '../shared/index.ts';
import { argsTypeOf, signatureOf } from './compile.ts';
import type { DatabaseInstance } from './instance.ts';
import { queryInstance, type QueryRunCtx, type QueryService } from './queries.ts';

/** A draft as the agent writes it: a saved query's draft, its `query` typed by the loaded tables, and this request's args. */
export interface AuthoringDraft {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly query: unknown;
  readonly sorters?: string[] | undefined;
  readonly args?: Record<string, Json> | undefined;
}

/** A saved query being changed (`edit_query`). */
export interface EditedQuery {
  readonly fn: string;
  /** Its name within the instance (`orders_by_status`); an edit keeps it. */
  readonly local: string;
  readonly payload: QueryPayload;
}

/** How the run ended up with its fn, and the args to run it with for this request. */
export interface Chosen {
  readonly how: QueryHow;
  readonly why: string;
  readonly args: Record<string, Json>;
}

/** One authoring run's own state: the database, its query service, the run's hub side, and what was chosen. */
export class QueryAuthoring {
  readonly here: DatabaseInstance;
  readonly queries: QueryService;
  readonly run: QueryRunCtx;
  readonly search: (query: FnSearchQuery) => Promise<FnSearchPage>;
  readonly editing: EditedQuery | undefined;
  /** Rows a clean read's check shows the agent. */
  readonly sampleRows: number;
  #chosen: Chosen | undefined;

  constructor(input: { here: DatabaseInstance; queries: QueryService; run: QueryRunCtx; search: (query: FnSearchQuery) => Promise<FnSearchPage>; editing?: EditedQuery | undefined; sampleRows: number }) {
    this.here = input.here;
    this.queries = input.queries;
    this.run = input.run;
    this.search = input.search;
    this.editing = input.editing;
    this.sampleRows = input.sampleRows;
  }

  /** How the fn was come by, once it was saved or reused. */
  get chosen(): Chosen | undefined {
    return this.#chosen;
  }

  choose(chosen: Chosen): void {
    this.#chosen = chosen;
  }

  /** The engine's types of these tables (all of them when none are named). */
  types(names: readonly string[]): Type[] {
    const all = this.here.catalog.engine.registry.typeList();
    return names.length === 0 ? all : all.filter((type) => names.includes(type.name));
  }

  /** The table names the agent may load: the engine's type names. */
  tableNames(): string[] {
    return this.here.catalog.engine.registry.typeList().map((type) => type.name);
  }
}

type Session = AuthoringSession<QueryAuthoring, AuthoringDraft>;

/** A call written the way the chat model writes one. */
export function callText(fn: string, args: Readonly<Record<string, Json>>): string {
  return `${fn}(${JSON.stringify(args)})`;
}

/** The draft as the instance checks and keeps it (`QueryService.check` / `save`). */
function asDraft(draft: AuthoringDraft): QueryDraft {
  return QueryDraft.parse({ name: draft.name, title: draft.title, description: draft.description, query: Json.parse(draft.query), ...(draft.sorters === undefined ? {} : { sorters: draft.sorters }) });
}

/** The query draft the examples write: orders with a status and their customer, biggest first. */
export const EXAMPLE_DRAFT = {
  name: 'orders_by_status', title: 'Orders by status', description: 'Orders with a given status and their customer, biggest first; the status is a param.', sorters: ['total', 'customer'],
  query: {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'orders', field: 'id' }, as: 'id' },
      { expr: { kind: 'field-ref', source: 'orders', field: 'total' }, as: 'total' },
      { expr: { kind: 'field-ref', source: 'customers', field: 'name' }, as: 'customer' },
    ],
    from: { kind: 'type', type: 'orders' },
    joins: [{ on: { kind: 'relation', source: 'orders', field: 'customer', as: 'customers' }, joinType: 'inner' }],
    where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'status' }, right: { kind: 'param', name: 'status' } }],
    order: [{ expr: { kind: 'field-ref', source: 'orders', field: 'total' }, dir: 'desc' }],
  },
  args: { status: 'paid' },
};

/** The agent's job, step by step, with a worked example. */
const INSTRUCTIONS = [
  'You write one saved database query for the request below, and nothing else. Work through the tools in order; each step unlocks the next.',
  '',
  '1. find_queries with the request in plain words. It lists saved queries of this database that may fit, and the database\'s tables.',
  '   A saved query that returns the same rows (other param values are fine) is the answer: call use_saved with its name and the args for this request.',
  '   When editing a saved query, it is listed first: load it with load_query.',
  '2. load_tables with only the tables the query needs (and load_query for a saved query you change). Call query_syntax once if you are unsure how to write an expression, a join, a group or a function.',
  '3. draft the whole query. Rules:',
  '   - Use only the loaded tables and their fields. A field is { "kind": "field-ref", "source": "<table>", "field": "<field>" }.',
  '   - Join over a relation field: "joins": [{ "on": { "kind": "relation", "source": "orders", "field": "customer", "as": "customers" } }], then read joined fields with source "customers".',
  '   - Every value the request leaves open (a name, a date, a status) is a { "kind": "param", "name": "<name>" }, so the query is reused with other values; give this request\'s values in "args". Fixed values are literals.',
  '   - Name output fields with "as". No "limit" for a list (callers page it); only a fixed top-N ("the 5 largest") has its own limit.',
  '   - "name" is snake_case, "title" a few words, "description" one sentence on what it returns and what its params are for (later requests are matched against it). "sorters" lists output fields a caller may sort by.',
  '   - Inserts, updates and deletes only when the request asks to change data; each run waits for the person\'s approval.',
  '4. The draft is checked at once. Fix every problem listed and draft again, whole.',
  '5. Once it is clean, call save. Then answer in one line.',
  '',
  'Example. For "orders with a given status (paid now), biggest first, with the customer\'s name", after loading orders and customers, the draft is:',
  JSON.stringify(EXAMPLE_DRAFT),
].join('\n');

/** `find_queries`: the saved queries of this database that may fit, and its tables by name. */
const findQueries = authoringTool<QueryAuthoring, AuthoringDraft, { text: string }>({
  name: 'find_queries',
  stage: 'find',
  description: 'Search the saved queries of this database by what the request wants, and list the database\'s tables.',
  instructions: 'Call it first, with the request in a few plain words.',
  schema: z.object({ text: z.string().min(1).describe('What the request wants, in plain words.') }),
  async call({ text }, session) {
    const state = session.state;
    const page = await state.search({ text, kinds: [QUERY_KIND], instance: state.here.instance, items: ['fn'], available: false, limit: 6 });
    const hits = page.items.filter((hit) => hit.name !== state.editing?.fn);
    const found = [...(state.editing === undefined ? [] : [state.editing.fn]), ...hits.map((hit) => hit.name)];
    session.disclosure.markSearched('fn');
    session.disclosure.markAware('fn', found);
    session.disclosure.markAware('table', state.tableNames());
    const tables = state.here.catalog.tableList();
    return [
      state.editing === undefined ? '' : `Editing ${state.editing.fn}: ${state.editing.payload.description}`,
      hits.length === 0 ? 'No saved query fits.' : 'Saved queries that may fit:',
      ...hits.map((hit) => `- ${hit.name}${hit.signature === undefined ? '' : ` ${hit.signature}`}: ${hit.description}`),
      `Tables of the ${state.here.config.label} database (${state.here.writes ? 'writes allowed, each after approval' : 'read-only'}): ${tables.join('; ')}.`,
      'Load the tables you need with load_tables.',
    ].filter((line) => line !== '').join('\n');
  },
});

/** `use_saved`: a saved query already does it; it runs with this request's args. */
const useSaved = authoringTool<QueryAuthoring, AuthoringDraft, { fn: string; args?: Record<string, Json> | undefined }>({
  name: 'use_saved',
  stage: 'find',
  description: 'Answer with a saved query find_queries listed that returns what was asked, run with this request\'s args.',
  schema: z.object({ fn: z.string().min(1), args: ParamValues.optional().describe('The values for its params, by name.') }),
  when: (session) => session.disclosure.searched('fn') && session.state.editing === undefined,
  async call({ fn, args }, session) {
    const state = session.state;
    if (!session.disclosure.awareUnloaded('fn').includes(fn) && !session.disclosure.isLoaded('fn', fn)) { throw new Error(`${fn} was not listed by find_queries.`); }
    const stored = await state.run.getFn(fn);
    const payload = QueryPayload.safeParse(stored.payload);
    if (stored.kind !== QUERY_KIND || !payload.success || payload.data.instance !== state.here.instance) { throw new Error(`${fn} is not a saved query of this database.`); }
    const compiled = state.here.compile(payload.data);
    if (!('query' in compiled)) { throw new Error(`${fn} no longer fits the tables: ${compiled.problems.join(' ')} Write a new query instead.`); }
    const given = args ?? {};
    const signature = signatureOf(stored.fn, argsTypeOf(compiled, payload.data.sorters, { page: 1, max: 1 }, payload.data.optional));
    state.choose({ how: 'reused', why: `The saved ${stored.fn} already does this.`, args: given });
    const result: AuthoredFn = { fn: stored.fn, version: stored.version, signature, about: payload.data.description, reused: true, call: callText(stored.fn, given) };
    session.finish(result);
    return `Using ${stored.fn}. Now answer in one line.`;
  },
});

/** `load_tables`: the named tables in full (fields, types, relations), only those. */
const loadTables = authoringTool<QueryAuthoring, AuthoringDraft, { names: string[] }>({
  name: 'load_tables',
  stage: 'inspect',
  description: 'Show tables in full: their fields with types, choices and ranges, and their relations. Load only the tables the query needs.',
  schema: z.object({ names: z.array(z.string().min(1)).min(1).describe('Table names as find_queries listed them.') }),
  when: (session) => session.disclosure.awareUnloaded('table').length > 0,
  call({ names }, session) {
    const known = session.state.tableNames();
    const unknown = names.filter((name) => !known.includes(name));
    if (unknown.length > 0) { throw new Error(`No table ${unknown.join(', ')}; the tables are ${known.join(', ')}.`); }
    session.disclosure.markLoaded('table', names);
    return describeTypes(session.state.here.catalog.engine, session.state.types(names));
  },
});

/** `load_query`: a saved query's description, sorters and JSON, to change it or write one like it. */
const loadQuery = authoringTool<QueryAuthoring, AuthoringDraft, { fn: string }>({
  name: 'load_query',
  stage: 'inspect',
  description: 'Show a saved query find_queries listed: its description, sorters and its query JSON.',
  schema: z.object({ fn: z.string().min(1) }),
  when: (session) => session.disclosure.awareUnloaded('fn').length > 0,
  async call({ fn }, session) {
    const state = session.state;
    const payload = state.editing?.fn === fn ? state.editing.payload : QueryPayload.safeParse((await state.run.getFn(fn)).payload).data;
    if (payload === undefined) { throw new Error(`${fn} is not a saved database query.`); }
    session.disclosure.markLoaded('fn', [fn]);
    return [`${fn}: ${payload.description}`, `Sorters: ${payload.sorters.join(', ') || 'none'}`, `Query: ${JSON.stringify(payload.query)}`].join('\n');
  },
});

/** `query_syntax`: the expressions, functions and worked examples usable on the loaded tables, once tables are loaded. */
const querySyntax = authoringTool<QueryAuthoring, AuthoringDraft, Record<string, never>>({
  name: 'query_syntax',
  stage: 'inspect',
  description: 'Show the query language for the loaded tables: every expression kind, the functions, and worked example queries.',
  schema: z.object({}),
  when: (session) => session.disclosure.loaded('table').length > 0 && !session.disclosure.isLoaded('docs', 'syntax'),
  call(_input, session) {
    const engine = session.state.here.catalog.engine;
    const types = session.state.types(session.disclosure.loaded('table'));
    session.disclosure.markLoaded('docs', ['syntax']);
    return [describeExprs(engine, types, 'all', 1), describeFunctions(engine, 'all', 1), describeQueryExamples(engine, 1)].join('\n\n');
  },
});

/** The draft's args: a saved query's draft whose `query` is the typed schema over the loaded tables. */
function draftSchema(session: Session): z.ZodType<AuthoringDraft> {
  const state = session.state;
  const schemas = buildSchemas(state.here.catalog.engine, { types: state.types(session.disclosure.loaded('table')) });
  return QueryDraft.omit({ query: true }).extend({
    query: schemas.Query.describe('The query, typed by the loaded tables.'),
    args: ParamValues.optional().describe('This request\'s values for the query\'s params, by name.'),
  });
}

/** The query authoring agent. Run it with the run's `ctx.ai()` and a `QueryAuthoring`. */
export const queryAuthoring = authoringAgent<QueryAuthoring, AuthoringDraft>({
  name: 'query_author',
  description: 'Find or write one saved database query for a request.',
  instructions: INSTRUCTIONS,
  tools: [findQueries, useSaved, loadTables, loadQuery, querySyntax],
  draft: { description: 'a saved query: name, title, description, the query, sorters, and this request\'s args.', schema: draftSchema },
  async check(draft, session) {
    const state = session.state;
    const problems: string[] = [];
    if (state.editing !== undefined && draft.name !== state.editing.local) { problems.push(`Keep the name "${state.editing.local}": this edits that query.`); }
    const trial = await state.queries.tryDraft(state.here, asDraft(draft), draft.args ?? {}, state.sampleRows);
    problems.push(...trial.check.problems);
    const note = [trial.check.sql === undefined ? '' : `SQL: ${trial.check.sql}`, trial.check.signature === undefined ? '' : `Fn: ${trial.check.signature}`].filter((line) => line !== '').join('\n');
    return { problems, ...(trial.sample === undefined ? {} : { preview: [...trial.sample] }), ...(note === '' ? {} : { note }) };
  },
  async save(draft, session) {
    const state = session.state;
    const args = draft.args ?? {};
    const saved = await state.queries.save(state.here, asDraft(draft), { args, askedFor: session.request, ...(state.editing === undefined ? {} : { replace: true }) }, state.run);
    if (!('fn' in saved)) { throw new Error('invalid' in saved ? saved.invalid : saved.failed); }
    state.choose(state.editing === undefined
      ? { how: 'created', why: `No saved query did this, so ${saved.fn} was written: ${draft.description}`, args }
      : { how: 'edited', why: `Changed as asked; version ${saved.version}. ${draft.description}`, args });
    const preview = session.lastCheck?.preview;
    return { fn: saved.fn, version: saved.version, signature: saved.signature, about: draft.description, reused: false, ...(preview === undefined ? {} : { preview }), call: callText(saved.fn, args) };
  },
});

/** A saved query's name within its instance, from its fn (`database/main.orders` → `orders`). */
export function localName(fn: string): string | undefined {
  const local = queryInstance(fn)?.local;
  return local === undefined ? undefined : local.slice(local.indexOf('.') + 1);
}
