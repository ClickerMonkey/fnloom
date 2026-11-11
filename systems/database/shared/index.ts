/**
 * The database system's contract (`shared/`). One instance per database (SQLite, Postgres or SQL Server). Every table
 * is a type in the hub (`<instance>.<table>`); every query the chat asks for is kept in the hub as a `database/query`
 * fn of its instance (`<instance>.<name>`, through `hub/save_fn`), so the next request finds it with `hub/fns_search`.
 * `get_query` and `edit_query` are agents: a prompt with this system's tools (`databases`, `tables`, `check_query`,
 * `save_query`, `run_query`) and the hub's (`fns_search`, `fn_get`, `fn_examples`). Rows go to the person as a
 * `result` attachment, which the app draws with its result view (its table, bar chart and value, and any visual a
 * system adds to the `query-visuals` registry, best fit first); the model gets a
 * `ResultBlock` that says so. Writes and schema changes only run once a person approves them.
 */
import { QualifiedName, ResultTable, type FnEffects, type OutputVerdict } from '@harness/core';
import { agent, attachment, context, fn, g, ginAs, hub, kind, system, type Infer, type ValidateCtx } from '@harness/sdk';
import {
  ApplyArgs, CONFIG_SECRETS, DatabaseConfig, DatabasePick, DatabaseSummary, PickArgs, InstanceAnswer, InstanceOp, ReadInstanceOp, ParamValues, QueryAgentAnswer, QueryAnswer, QueryCheck, QueryDraft, QueryPayload, QueryRun,
  type QueryHow,
  SavedQueryRef, SchemaArgs, SchemaChanged, TableArgs, TableFnsArgs, TableFnsGenerateArgs, TableFnsGenerated, TableFnsList, TablesInfo,
} from './shapes.ts';

export * from './shapes.ts';

/** The query result attachment's data: core's `ResultTable`. */
export const ResultData = ginAs(ResultTable);

/** The query visuals registry, by local name and qualified. */
export const VISUALS = 'query-visuals';
export const VISUALS_REGISTRY = `database/${VISUALS}` as const;

/** The kind of every saved query, qualified. */
export const QUERY_KIND = 'database/query';

const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: `${active} (again)`, many: `${active} (again)` },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** What a fn that keeps queries does: it creates and updates `database/query` fns in the hub (no table changes). */
const SAVES_QUERIES = {
  mode: 'write',
  free: true,
  registry: [{ thing: 'fns', action: 'create', kind: QUERY_KIND }, { thing: 'fns', action: 'update', kind: QUERY_KIND }],
} as const satisfies FnEffects;

/** `get_query`'s args. */
export const QueryArgs = g.obj({
  detailedDescription: g.field(g.text({ minLength: 1 }), { docs: 'What the query does: the rows, columns, filters, grouping, order, and the values to use.' }),
  database: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'The database instance (`main`); worked out from the description when empty.' }),
});

/** `edit_query`'s args. */
export const EditArgs = g.obj({
  name: g.field(g.text({ minLength: 1 }), { docs: 'The query fn (`database/main.overdue_invoices`).' }),
  instructions: g.field(g.text({ minLength: 1 }), { docs: 'What to change, and the values to run it with.' }),
});

const databaseArg = () => g.field(g.text({ minLength: 1 }), { docs: 'The database instance (`main`), as `databases` lists it.' });

const RESULT_GUIDE = 'You get the columns, counts and the first rows. When a person is watching, the rows are also shown to them (as a table or another visual) and the result\'s `shown` says so: don\'t repeat them, summarize or point out what matters. Page with `limit` and `offset`.';

/** A query over the shop example's tables, as the examples write it. */
const ORDERS_BY_STATUS = {
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
};

const ORDERS_DRAFT = { name: 'orders_by_status', title: 'Orders by status', description: 'Orders with a given status and their customer, biggest first.', query: ORDERS_BY_STATUS, sorters: ['total', 'customer'] };

/** How the query agents work, step by step (shared by `get_query` and `edit_query`). */
const QUERY_STEPS = [
  'Writing a query:',
  '- Call database/tables first: it gives the tables as types, their columns (with their choices, formats and ranges), relations, and the query language.',
  '- Use only those types and fields. A field is { "kind": "field-ref", "source": "<type>", "field": "<field>" }. Join over a relation field with',
  '  "joins": [ { "on": { "kind": "relation", "source": "orders", "field": "customer", "as": "customers" } } ] and read joined fields with source "customers".',
  '- Every value the request leaves open (a name, a date, a status) is a { "kind": "param", "name": "<name>" } so the query is reused with other values; fixed values are literals.',
  '- Name output fields with "as". No "limit" for a list: callers page it. Only a fixed top-N ("the 5 largest") has its own limit.',
  '- For a write (insert, update, delete), only on a database whose tables say writes are allowed; it waits for the person\'s approval.',
  '- Call database/check_query with the draft and fix every problem it lists until `ok` is true. hub/fn_examples with fn "database/get_query" pages more worked queries.',
  '',
  'Example. For "orders with a given status (paid now), biggest first, with the customer\'s name", the draft is:',
  JSON.stringify(ORDERS_DRAFT),
  'saved with args { "status": "paid" }.',
].join('\n');

/** How the query agents answer: run_query's answer as it came, with how and why added to its fn. */
const QUERY_ANSWER = [
  'Answer with the answer database/run_query gave, exactly as it came: { "database", "fn", "query", and "result" or "approval" }. Copy it; never',
  'change, shorten or make up any part of it. Add two fields to its "fn": "how" ("reused" a saved query, "created" a new one, or "edited" one) and',
  '"why" (one sentence: the saved query that fit, or what was written or changed). For example, after run_query answered',
  '{ "database": { "instance": "main", "label": "Shop", "dialect": "sqlite" }, "fn": { "name": "database/main.orders_by_status", "signature": "…" }, "query": { … }, "result": { … } },',
  'answer the same object with "fn": { "name": "database/main.orders_by_status", "signature": "…", "how": "created", "why": "No saved query listed orders by status, so one was written with the status as a param." }.',
].join(' ');

/** `get_query`'s prompt. */
const GET_QUERY_AGENT = [
  'You find or write the database query for this request and run it:',
  '',
  '{{args.detailedDescription}}',
  '',
  'Database asked for (may be empty): "{{args.database}}"',
  '',
  'Work in this order:',
  '1. The database: the one asked for; else call database/databases. With one, use it; else pick the one whose tables answer the request. When two',
  '   could and the request does not say, run nothing and answer { "ask": "Which database: Shop or Billing?", "databases": ["shop", "billing"] }.',
  `2. Look for a saved query: call hub/fns_search with \`text\` (what the request wants, in plain words), \`kinds: ["${QUERY_KIND}"]\` and \`instance\` set to the database.`,
  '   A hit whose description returns the same rows (other param values are fine) is a match: call database/run_query with its name and the args for this request.',
  '3. Otherwise write one (below), call database/save_query with the draft, the args for this request and the request as `askedFor`, then database/run_query with the saved fn.',
  '',
  QUERY_STEPS,
  '',
  QUERY_ANSWER,
].join('\n');

/** `edit_query`'s prompt. */
const EDIT_QUERY_AGENT = [
  'You change the saved query {{args.name}} as asked, keep the change, and run it:',
  '',
  '{{args.instructions}}',
  '',
  'Work in this order:',
  '1. Call hub/fn_get with the fn name. Its payload holds the query (`query`), its `description`, `sorters` and the database (`instance`).',
  '2. Call database/tables for that database, change the query as asked, and check it with database/check_query until `ok` is true.',
  '3. Call database/save_query with the same name (the part after the database and the dot), `replace: true`, the new draft and the args for this request.',
  '   The hub keeps the old version in its history.',
  '4. Call database/run_query with the fn and the args.',
  '',
  QUERY_STEPS,
  '',
  QUERY_ANSWER,
].join('\n');

/** How a query's args are given: the tool schema can only say `any JSON` for them, so the words say it. */
const PARAM_VALUES_DOCS = 'An object of the values by param name, such as { "status": "paid" }: a JSON object, never a string holding JSON.';

/**
 * The query agents' answer check: the fn it names must be a saved query of the database it names, and the answer
 * must carry that run's result or approval, so a model that answers without finding or saving one, and running it,
 * is sent back to do that. `asking` lets `get_query` ask which database instead.
 */
async function checkAnswer(ctx: ValidateCtx, answer: QueryAgentAnswer, asking: boolean): Promise<OutputVerdict> {
  const retry = (why: string): OutputVerdict => ({
    ok: false, action: 'retry', reason: `${why} Follow the steps: find or save the query, run it with database/run_query, then answer with run_query's answer as it came, adding how and why to its fn.`,
  });
  if ('ask' in answer) { return asking ? { ok: true } : retry('edit_query always knows its database: it is the saved query\'s.'); }
  const name = QualifiedName.safeParse(answer.fn.name);
  if (!name.success) { return retry(`"${answer.fn.name}" is not a saved query fn (database/<database>.<name>).`); }
  const [hit] = (await ctx.searchFns({ names: [name.data], kinds: [QUERY_KIND], items: ['fn'], available: false, limit: 1 })).items;
  if (hit === undefined) { return retry(`There is no saved query ${answer.fn.name}.`); }
  if (hit.instance !== undefined && hit.instance !== answer.database.instance) { return retry(`${answer.fn.name} is a query of database "${hit.instance}", not "${answer.database.instance}".`); }
  if ((answer.result === undefined) === (answer.approval === undefined)) { return retry('The answer carries run_query\'s "result" (a read) or its "approval" (a write), one of them.'); }
  if (answer.result !== undefined && answer.result.fn.name !== answer.fn.name) { return retry(`The result is of ${answer.result.fn.name}, not ${answer.fn.name}.`); }
  return { ok: true };
}

/** A worked answer for the examples: run_query's answer for paid or open orders, with how and why. */
function exampleAnswer(how: QueryHow, why: string, status: string, rows: { id: number; total: number; customer: string }[], total: number): QueryAnswer {
  const name = 'database/main.orders_by_status';
  const signature = `${name}(status: text, limit?: num, offset?: num, sort?: list<{ column: "total" | "customer", dir: "asc" | "desc" }>)`;
  return {
    database: { instance: 'main', label: 'Shop', dialect: 'sqlite' },
    fn: { name, signature, how, why },
    query: {
      sql: 'SELECT orders.id AS id, orders.total AS total, customers.name AS customer, COUNT(*) OVER () AS "$total" FROM orders INNER JOIN customers ON customers.id = orders.customer WHERE orders.status = ? ORDER BY orders.total DESC LIMIT ? OFFSET ?',
      structured: ORDERS_BY_STATUS, params: { status, limit: 50, offset: 0 }, writes: false,
    },
    result: {
      shown: 'The person sees these rows as a table; summarize them, don\'t repeat them.',
      columns: [{ name: 'id', kind: 'integer', nullable: false }, { name: 'total', kind: 'number', nullable: false }, { name: 'customer', kind: 'text', nullable: false }],
      rowCount: rows.length, total, truncated: false, sort: [], sample: rows, fn: { name, signature },
    },
  };
}

/** The database system's contract. */
export const database = system('database', {
  description: 'Query and change SQL databases (SQLite, Postgres, SQL Server): every table is a type, and every query asked for is kept in the hub as a fn for next time.',
  registries: {
    [VISUALS]: { description: 'Ways to draw rows a query read. Each entry says whether a result fits it and how well. The app draws the table, a bar chart and a single value itself; systems add more here.', data: ResultData },
  },
  configSecrets: [...CONFIG_SECRETS],
  // the query agents and enrichment use models; writes and schema changes wait for approval; get_query asks the hub to
  // pick a database; saved queries are hub fns it searches, reads and saves
  grants: { hub: ['ai', 'approvals', 'decide', 'search', 'fns'], calls: ['hub/fn_get', 'hub/save_fn', 'hub/fns_search', 'hub/fn_examples'] },
})
  .with({
    config: ginAs(DatabaseConfig),
    attachments: {
      result: attachment({ description: 'Rows a query read, drawn by the best fitting query visual (a table by default).', data: ResultData }),
    },
    kinds: {
      query: kind({
        description: 'A saved query over one database: running it reads (or, after approval, writes) rows. Its args are the query\'s params, `limit` / `offset` for a list, and `sort`.',
        applicability: 'A question about the data in a database the chat will ask again (overdue invoices, sales by month).',
        payload: ginAs(QueryPayload),
        // get_query keeps every query it makes; a saved query that writes still waits for approval on every run
        approveChanges: false,
        // a query runs SQL and never calls a model, so its implementation says every run is free
        estimates: true,
        status: status('Querying {fn}…', 'Queried {fn}', 'Query {fn} failed'),
      }),
    },
    fns: {
      at_instance: fn({
        description: 'Do one query tool\'s work on this database instance (the tools forward here with `on` when another instance has the database).',
        instructions: 'Called by this system\'s own tools only.',
        args: ginAs(InstanceOp),
        returns: ginAs(InstanceAnswer),
        deps: { getFn: hub.fns.fn_get, saveFn: hub.fns.save_fn },
        examples: [{ args: { op: 'run', fn: 'database/main.orders_by_status', args: { status: 'paid' } }, note: 'Run a saved query on the instance it runs on.' }],
        visibility: 'none',
        display: 'hidden',
        effects: SAVES_QUERIES,
        // `read` lets the system's own tools call it without asking (the writes it forwards ask for themselves)
        tags: ['database', 'read'],
      }),
      read_at_instance: fn({
        description: 'Do one reading query tool\'s work on this database instance: its tables, a draft\'s check, a table\'s generated fns (the read tools forward here with `on`).',
        instructions: 'Called by this system\'s own read tools only.',
        args: ginAs(ReadInstanceOp),
        returns: ginAs(InstanceAnswer),
        deps: { getFn: hub.fns.fn_get },
        examples: [{ args: { op: 'tables' }, note: 'The tables of the instance it runs on.' }],
        visibility: 'none',
        display: 'hidden',
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
      change_schema: fn({
        description: 'Create or change a table from a row type on one database instance, once approved (create_table and alter_table forward here).',
        instructions: 'Called by create_table and alter_table, which say which instance; the person approves the DDL first.',
        args: ginAs(SchemaArgs),
        returns: ginAs(SchemaChanged),
        examples: [{ args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } } } }, action: 'create', database: 'main' } }],
        visibility: 'none',
        approval: { preview: true, remember: false },
        status: status('Changing {args.table}…', 'Changed {args.table}', 'Changing {args.table} failed'),
        effects: { mode: 'delete', free: true, registry: [{ thing: 'types', action: 'create' }, { thing: 'types', action: 'update' }, { thing: 'types', action: 'remove' }] },
        tags: ['database', 'schema', 'write'],
      }),
      apply_type_changes: fn({
        description: 'Apply the table type changes a rescan found that would break saved queries or drop a type. Proposed by the system for an admin to approve.',
        instructions: 'The system proposes it after a rescan; an admin approves it from the approval\'s type diff. Run it again with the same scan to no effect.',
        args: ginAs(ApplyArgs),
        returns: ginAs(SchemaChanged),
        examples: [{ args: { scan: 'scan_0f3c9a' }, note: 'The scan id comes from the proposal.' }],
        // only the system proposes it, for admins to approve: nobody calls it directly
        visibility: 'none',
        status: status('Applying type changes…', 'Applied type changes', 'Applying type changes failed'),
        effects: { mode: 'write', free: true, registry: [{ thing: 'types', action: 'update' }, { thing: 'types', action: 'remove' }] },
        tags: ['database', 'schema'],
      }),
      pick_database: fn({
        description: 'Which database a request is for: the one it names, the only one the person may use, the decision model\'s pick between them, or the question to ask the person.',
        instructions: 'get_query\'s first step. When the answer is `ask`, run nothing: the person picks the database (input/ask_choice with the labels as options) and the request comes again with it.',
        args: ginAs(PickArgs),
        returns: ginAs(DatabasePick),
        examples: [
          { args: { detailedDescription: 'Paid orders, biggest first.', database: 'main' }, result: { database: 'main', label: 'Shop', by: 'asked', why: 'The request names the Shop database.' } },
          { args: { detailedDescription: 'Every invoice that is overdue.' }, result: { ask: 'Which database: Shop or Billing?', databases: ['main', 'billing'] }, note: 'Two databases could hold invoices.' },
        ],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        // the decision model it may ask is a model call of the run
        effects: { mode: 'read' },
        tags: ['database', 'read'],
      }),
      databases: fn({
        description: 'The databases this system serves: each instance, its label and its tables.',
        instructions: 'Call it when the database is not given, to pick the one whose tables answer the request. Only databases the person may use are listed.',
        args: g.obj({}),
        returns: g.list(ginAs(DatabaseSummary)),
        examples: [{ args: {}, result: [{ instance: 'main', label: 'Shop', tables: ['customers (people who buy)', 'orders (one per checkout)'] }] }],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
    },
  })
  .with(({ fns }) => ({
    fns: {
      tables: fn({
        description: 'One database\'s tables as types: columns, their choices, formats and ranges, relations, and how to write queries against them.',
        instructions: 'Call it before writing or changing a query, and write only against what it lists.',
        args: g.obj({ database: databaseArg() }),
        returns: ginAs(TablesInfo),
        deps: { at: fns.read_at_instance },
        examples: [{ args: { database: 'main' } }],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
      check_query: fn({
        description: 'Check a draft query against a database\'s tables: whether it runs, its SQL and signature, or each problem and how to fix it.',
        instructions: 'Check every draft before saving it, and fix each listed problem. A write on a read-only database is a problem.',
        args: g.obj({ database: databaseArg(), draft: ginAs(QueryDraft) }),
        returns: ginAs(QueryCheck),
        deps: { at: fns.read_at_instance },
        examples: [{
          args: { database: 'main', draft: ORDERS_DRAFT },
          result: { ok: true, problems: [], writes: false, sql: 'SELECT orders.id AS id, … WHERE orders.status = ? ORDER BY orders.total DESC', signature: 'database/main.orders_by_status(status: text, limit?, offset?, sort?) → rows' },
        }],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
      save_query: fn({
        description: 'Keep a checked query in the hub as a `database/query` fn of its database (`database/<database>.<name>`), shared as the database says; with `replace`, a new version of a saved one.',
        instructions: 'Save only drafts check_query passed. Give the args for this request (kept as its first example) and the request as `askedFor`. A taken name without `replace` is saved under the next free one.',
        args: g.obj({
          database: databaseArg(),
          draft: ginAs(QueryDraft),
          args: g.field(g.optional(ginAs(ParamValues)), { docs: PARAM_VALUES_DOCS }),
          askedFor: g.field(g.optional(g.text()), { docs: 'The request it was written for.' }),
          replace: g.field(g.optional(g.bool()), { docs: 'Save over the saved query of this name (edit_query), keeping the old version.' }),
        }),
        returns: ginAs(SavedQueryRef),
        deps: { at: fns.at_instance },
        examples: [{
          args: { database: 'main', draft: ORDERS_DRAFT, args: { status: 'paid' }, askedFor: 'paid orders, biggest first, with the customer' },
          result: { fn: 'database/main.orders_by_status', signature: 'database/main.orders_by_status(status: text, limit?, offset?, sort?) → rows', version: 1, created: true },
        }],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        // keeping a query changes no table, but it creates or updates a hub fn; a write query asks for approval each time it runs
        effects: SAVES_QUERIES,
        tags: ['database', 'query'],
      }),
      table_fns_available: fn({
        description: 'Every fn that could be generated for a table, grouped (CRUD, column helpers, the whole table, and each relation), the most useful first: its name, what it does, its signature, whether it writes, and whether it exists already (with its version).',
        instructions: 'Use it to offer a table\'s ready-made fns (create, update, selectPage, counts, sums, a parent\'s child counts, a row\'s rank among its siblings) before writing a query by hand. Pass the names you want to database/table_fns_generate. `stale` means the table changed since it was made: generate it again.',
        args: ginAs(TableFnsArgs),
        returns: ginAs(TableFnsList),
        deps: { at: fns.read_at_instance },
        examples: [
          { args: { table: 'database/main.projects' }, note: 'The fns of the projects table of the main database.' },
          { args: { table: 'owners', database: 'main' }, note: 'An owner gets projectCount, projectAvgValue and projectTotalValue from its projects.' },
        ],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
      table_fns_generate: fn({
        description: 'Make (or bring up to date) a table\'s generated fns by name, as saved query fns of its database with instructions and examples. Unchanged ones are left as they are; changed ones get a new version.',
        instructions: 'Give the names table_fns_available lists. Fns that write wait for the person\'s approval every time they run. `derived` adds derived fields (projectCount) to selectPage, to show, sort and filter on. The answer names each fn: call it directly.',
        args: ginAs(TableFnsGenerateArgs),
        returns: ginAs(TableFnsGenerated),
        deps: { at: fns.at_instance },
        examples: [
          {
            args: { table: 'database/main.projects', names: ['selectPage', 'create', 'ownerRelativeValueRank'] },
            result: { database: { instance: 'main', label: 'Projects', dialect: 'sqlite' }, table: 'projects', fns: [{ fn: 'database/main.projects_selectPage', signature: 'database/main.projects_selectPage(owner?: num, limit?: num, offset?: num)', version: 1, status: 'created' }] },
          },
          { args: { table: 'owners', database: 'main', names: ['selectPage'], derived: ['projectCount', 'projectTotalValue'] }, note: 'Owners with their project count and total, sortable by them.' },
        ],
        visibility: 'llm',
        routing: { to: 'any' },
        effects: SAVES_QUERIES,
        tags: ['database', 'query'],
      }),
      run_query: fn({
        description: 'Run a saved query fn with args: a read gives you the columns, counts and first rows (and shows the rows to the person when one is watching); a write waits for the person\'s approval.',
        instructions: `Give the args by the fn's signature (its params, and \`limit\`, \`offset\`, \`sort\` for a list). ${RESULT_GUIDE}`,
        args: g.obj({
          fn: g.field(g.text({ minLength: 1 }), { docs: 'The saved query fn (`database/main.orders_by_status`).' }),
          args: g.field(g.optional(ginAs(ParamValues)), { docs: PARAM_VALUES_DOCS }),
        }),
        returns: ginAs(QueryRun),
        deps: { at: fns.at_instance },
        examples: [
          { args: { fn: 'database/main.orders_by_status', args: { status: 'paid' } }, note: 'The first page.' },
          { args: { fn: 'database/main.orders_by_status', args: { status: 'open', offset: 50, limit: 50, sort: [{ column: 'customer', dir: 'asc' }] } }, note: 'The next page, by customer.' },
        ],
        visibility: 'llm',
        routing: { to: 'any' },
        // it runs any saved query, writes included; each write still waits for the person's approval
        effects: { mode: 'write', free: true },
        tags: ['database'],
      }),
    },
  }))
  .with(({ fns }) => ({
    fns: {
      get_query: agent({
        description: 'Read or change data in a database: describe in detail what you want, and a saved query that does it is reused, or a new one is written, kept and run.',
        usage: `Say which rows, columns, filters, grouping and order you want, and any values (as params, e.g. "for a customer given by name"). The answer names the query's fn: call it directly next time. ${RESULT_GUIDE} A write (insert, update, delete) waits for the person to approve it.`,
        args: QueryArgs,
        returns: ginAs(QueryAgentAnswer),
        instructions: GET_QUERY_AGENT,
        tools: [fns.databases, hub.fns.fns_search, hub.fns.fn_get, hub.fns.fn_examples, fns.tables, fns.check_query, fns.save_query, fns.run_query],
        toolExecution: 'sequential',
        maxIterations: 14,
        examples: [
          {
            args: { detailedDescription: 'Paid orders, biggest total first, with the customer\'s name.', database: 'main' },
            result: exampleAnswer('created', 'No saved query listed orders by status, so one was written with the status as a param.', 'paid', [{ id: 7, total: 940, customer: 'Ada' }, { id: 3, total: 410, customer: 'Bo' }], 2),
          },
          {
            args: { detailedDescription: 'Open orders, biggest first, with the customer.' },
            result: exampleAnswer('reused', 'The saved orders_by_status query does this with status "open".', 'open', [{ id: 9, total: 120, customer: 'Cy' }], 1),
          },
          { args: { detailedDescription: 'Total sales per month in 2025, by month.' }, note: 'A grouped query with the year as a param.' },
          {
            args: { detailedDescription: 'Every invoice that is overdue.' },
            result: { ask: 'Which database: Shop or Billing?', databases: ['main', 'billing'] },
            note: 'Two databases could hold invoices and the request does not say which.',
          },
        ],
        validate: { output: (ctx, _args, answer) => checkAnswer(ctx, answer, true) },
        status: status('Finding a query…', 'Queried the database', 'The query failed'),
        tags: ['database', 'query'],
      }),
      edit_query: agent({
        description: 'Change a saved query fn by instructions (add a column, another filter, a different order). The old version is kept; the new one runs.',
        usage: `Name the saved query fn and say exactly what to change and the values to run it with. ${RESULT_GUIDE}`,
        args: EditArgs,
        returns: ginAs(QueryAnswer),
        instructions: EDIT_QUERY_AGENT,
        tools: [hub.fns.fn_get, hub.fns.fn_examples, fns.tables, fns.check_query, fns.save_query, fns.run_query],
        toolExecution: 'sequential',
        maxIterations: 12,
        examples: [{
          args: { name: 'database/main.orders_by_status', instructions: 'Also show the order date, newest first; run it for paid orders.' },
          result: exampleAnswer('edited', 'Added the customer\'s name and ordered by the total, biggest first; version 2.', 'paid', [{ id: 7, total: 940, customer: 'Ada' }, { id: 3, total: 410, customer: 'Bo' }], 2),
        }],
        validate: { output: (ctx, _args, answer) => checkAnswer(ctx, answer, false) },
        status: status('Editing {args.name}…', 'Edited {args.name}', 'Editing {args.name} failed'),
        tags: ['database', 'query'],
      }),
      create_table: fn({
        description: 'Make a table from a row type (on a database whose schema may change). Runs only after the person approves the DDL.',
        instructions: 'Give the table name and a row type whose fields are the columns; `id` is the primary key. Say what it is for; the person sees the DDL before it runs.',
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        examples: [{ args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } } } }],
        status: status('Creating {args.table}…', 'Created {args.table}', 'Creating {args.table} failed'),
        effects: { mode: 'write', free: true, registry: [{ thing: 'types', action: 'create' }] },
        tags: ['database', 'schema', 'write'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
      alter_table: fn({
        description: 'Change a table to match a row type: add, drop and change columns (on a database whose schema may change). Runs only after the person approves the steps.',
        instructions: 'Give the whole row type as it should be; dropping a column or narrowing one can lose data and is marked so in the approval.',
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        examples: [{ args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } }, done: { type: { name: 'bool' } } } } }, note: 'Adds `done`, drops `due`.' }],
        status: status('Changing {args.table}…', 'Changed {args.table}', 'Changing {args.table} failed'),
        effects: { mode: 'delete', free: true, registry: [{ thing: 'types', action: 'update' }] },
        tags: ['database', 'schema', 'write'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
    },
  }))
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to work with the databases.',
        content: [
          'Each table of each database is a type (`<database>.<table>`), and saved queries are fns (`database/<database>.<name>`).',
          'To read or change data, call a saved query fn when one fits, else get_query with a detailed description; edit_query changes one.',
          "For a table's everyday fns (create, update, remove, selectPage, counts and sums, a parent's child counts), list them with table_fns_available and make them with table_fns_generate.",
          RESULT_GUIDE,
          'Writes and schema changes (create_table, alter_table) wait for the person to approve them: say what will happen and wait.',
        ].join(' '),
        fns: [fns.get_query, fns.edit_query, fns.table_fns_available, fns.table_fns_generate, fns.create_table, fns.alter_table],
        tags: ['database'],
      }),
    },
  }));

/** The database contract's type. */
export type DatabaseContract = typeof database;
/** The query result attachment's data. */
export type ResultDataValue = Infer<typeof ResultData>;
