/**
 * The database system's contract (`shared/`). One instance per database (SQLite, Postgres or SQL Server). Every table
 * is a type in the hub (`<instance>.<table>`); every query the chat asks for is kept in the hub as a `database/query`
 * fn of its instance (`<instance>.<name>`, through `hub/save_fn`), so the next request finds it with `hub/fns_search`.
 * `get_query` and `edit_query` are agents: a prompt with this system's tools (`databases`, `tables`, `check_query`,
 * `save_query`, `run_query`) and the hub's (`fns_search`, `fn_get`, `fn_examples`). Rows go to the person as a
 * `result` attachment, drawn by the best fitting visual of the `query-visuals` registry; the model gets a
 * `ResultBlock` that says so. Writes and schema changes only run once a person approves them.
 */
import { QualifiedName, ResultTable, type OutputVerdict } from '@harness/core';
import { agent, attachment, context, fn, g, ginAs, hub, kind, system, type Infer, type ValidateCtx } from '@harness/sdk';
import {
  ApplyArgs, CONFIG_SECRETS, DatabaseConfig, DatabaseSummary, InstanceAnswer, InstanceOp, ParamValues, QueryAgentAnswer, QueryCheck, QueryDraft, QueryPayload, QueryRun,
  SavedQueryRef, SchemaArgs, SchemaChanged, TableArgs, TablesInfo,
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

const RESULT_GUIDE = 'The rows are shown to the person (as a table or another visual); you get the columns, counts and the first rows. Don\'t repeat the rows: summarize or point out what matters. Page with `limit` and `offset`.';

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

/** How `get_query`'s summary starts when it can't tell which database the request is for (then it names no fn). */
const ASK_WHICH = 'Ask which database:';

const QUERY_ANSWER ='Answer with { "database", "fn", "how" (reused, created or edited), "why", "summary" }: the summary says what the result shows (counts, what stands out) or that the write waits for approval, never the rows themselves.';

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
  `   could and the request does not say, answer with summary "${ASK_WHICH} <the labels>" and how "reused", fn "".`,
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

/** The query agents' answer, as gin. */
const QueryAgentAnswerType = ginAs(QueryAgentAnswer);

/**
 * The query agents' answer check: the fn it names must be a saved query of the database it names, so a model that
 * answers without finding or saving one, and running it, is sent back to do that. `asking` lets `get_query` name no fn
 * when it has to ask which database.
 */
async function checkAnswer(ctx: ValidateCtx, answer: QueryAgentAnswer, asking: boolean): Promise<OutputVerdict> {
  if (asking && answer.fn === '' && answer.summary.startsWith(ASK_WHICH)) { return { ok: true }; }
  const retry = (why: string): OutputVerdict => ({
    ok: false, action: 'retry', reason: `${why} Follow the steps: find or save the query, run it with database/run_query, then answer with that fn's name.`,
  });
  const name = QualifiedName.safeParse(answer.fn);
  if (!name.success) { return retry(`"${answer.fn}" is not a saved query fn (database/<database>.<name>).`); }
  const [hit] = (await ctx.searchFns({ names: [name.data], kinds: [QUERY_KIND], items: ['fn'], available: false, limit: 1 })).items;
  if (hit === undefined) { return retry(`There is no saved query ${answer.fn}.`); }
  if (hit.instance !== undefined && hit.instance !== answer.database) { return retry(`${answer.fn} is a query of database "${hit.instance}", not "${answer.database}".`); }
  return { ok: true };
}

/** The database system's contract. */
export const database = system('database', {
  description: 'Query and change SQL databases (SQLite, Postgres, SQL Server): every table is a type, and every query asked for is kept in the hub as a fn for next time.',
  registries: {
    [VISUALS]: { description: 'Ways to draw rows a query read. Each entry says whether a result fits it and how well; the table always fits.', data: ResultData },
  },
  contributes: [
    { registry: VISUALS_REGISTRY, name: 'table', label: 'Table', description: 'Every row and column.', icon: 'table' },
    { registry: VISUALS_REGISTRY, name: 'bar', label: 'Bar chart', description: 'One label and one number per row.', icon: 'chart' },
    { registry: VISUALS_REGISTRY, name: 'value', label: 'Value', description: 'A single value, large.', icon: 'number' },
  ],
  configSecrets: [...CONFIG_SECRETS],
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
        examples: [{ args: { op: 'tables' }, note: 'The tables of the instance it runs on.' }],
        visibility: 'none',
        display: 'hidden',
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
        tags: ['database', 'schema', 'write'],
      }),
      apply_type_changes: fn({
        description: 'Apply the table type changes a rescan found that would break saved queries or drop a type. Proposed by the system for an admin to approve.',
        instructions: 'The system proposes it after a rescan; an admin approves it from the approval\'s type diff. Run it again with the same scan to no effect.',
        args: ginAs(ApplyArgs),
        returns: ginAs(SchemaChanged),
        examples: [{ args: { scan: 'scan_0f3c9a' }, note: 'The scan id comes from the proposal.' }],
        visibility: 'user',
        status: status('Applying type changes…', 'Applied type changes', 'Applying type changes failed'),
        tags: ['database', 'schema'],
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
        deps: { at: fns.at_instance },
        examples: [{ args: { database: 'main' } }],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
        tags: ['database', 'read'],
      }),
      check_query: fn({
        description: 'Check a draft query against a database\'s tables: whether it runs, its SQL and signature, or each problem and how to fix it.',
        instructions: 'Check every draft before saving it, and fix each listed problem. A write on a read-only database is a problem.',
        args: g.obj({ database: databaseArg(), draft: ginAs(QueryDraft) }),
        returns: ginAs(QueryCheck),
        deps: { at: fns.at_instance },
        examples: [{
          args: { database: 'main', draft: ORDERS_DRAFT },
          result: { ok: true, problems: [], writes: false, sql: 'SELECT orders.id AS id, … WHERE orders.status = ? ORDER BY orders.total DESC', signature: 'database/main.orders_by_status(status: text, limit?, offset?, sort?) → rows' },
        }],
        visibility: 'llm',
        display: 'hidden',
        routing: { to: 'any' },
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
        // keeping a query changes no table (it is a hub fn); a write query asks for approval each time it runs
        effects: { mode: 'read', free: true },
        tags: ['database', 'query'],
      }),
      run_query: fn({
        description: 'Run a saved query fn with args: a read shows its rows to the person and gives you the columns, counts and first rows; a write waits for the person\'s approval.',
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
        // a read only reads; the run of a write query it starts asks the person itself
        effects: { mode: 'read', free: true },
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
        returns: QueryAgentAnswerType,
        instructions: GET_QUERY_AGENT,
        tools: [fns.databases, hub.fns.fns_search, hub.fns.fn_get, hub.fns.fn_examples, fns.tables, fns.check_query, fns.save_query, fns.run_query],
        toolExecution: 'sequential',
        maxIterations: 14,
        examples: [
          {
            args: { detailedDescription: 'Paid orders, biggest total first, with the customer\'s name.', database: 'main' },
            result: { database: 'main', fn: 'database/main.orders_by_status', how: 'created', why: 'No saved query listed orders by status, so one was written with the status as a param.', summary: '12 paid orders; the largest is 940.00 from Ada.' },
          },
          {
            args: { detailedDescription: 'Open orders, biggest first, with the customer.' },
            result: { database: 'main', fn: 'database/main.orders_by_status', how: 'reused', why: 'The saved orders_by_status query does this with status "open".', summary: '3 open orders, all from gold customers.' },
          },
          { args: { detailedDescription: 'Total sales per month in 2025, by month.' }, note: 'A grouped query with the year as a param.' },
        ],
        validate: { output: (ctx, _args, answer) => checkAnswer(ctx, answer, true) },
        status: status('Finding a query…', 'Ran {output.fn}', 'The query failed'),
        tags: ['database', 'query'],
      }),
      edit_query: agent({
        description: 'Change a saved query fn by instructions (add a column, another filter, a different order). The old version is kept; the new one runs.',
        usage: `Name the saved query fn and say exactly what to change and the values to run it with. ${RESULT_GUIDE}`,
        args: EditArgs,
        returns: QueryAgentAnswerType,
        instructions: EDIT_QUERY_AGENT,
        tools: [hub.fns.fn_get, hub.fns.fn_examples, fns.tables, fns.check_query, fns.save_query, fns.run_query],
        toolExecution: 'sequential',
        maxIterations: 12,
        examples: [{
          args: { name: 'database/main.orders_by_status', instructions: 'Also show the order date, newest first; run it for paid orders.' },
          result: { database: 'main', fn: 'database/main.orders_by_status', how: 'edited', why: 'Added the placed date and ordered by it, newest first; version 2.', summary: '12 paid orders, the newest from yesterday.' },
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
          RESULT_GUIDE,
          'Writes and schema changes (create_table, alter_table) wait for the person to approve them: say what will happen and wait.',
        ].join(' '),
        fns: [fns.get_query, fns.edit_query, fns.create_table, fns.alter_table],
        tags: ['database'],
      }),
    },
  }));

/** The database contract's type. */
export type DatabaseContract = typeof database;
/** The query result attachment's data. */
export type ResultDataValue = Infer<typeof ResultData>;
