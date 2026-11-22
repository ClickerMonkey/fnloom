/**
 * The database system's contract (`shared/`). One instance per database (SQLite, Postgres or SQL Server). Every table
 * is a type in the hub (`<instance>.<table>`); every query the chat asks for is kept in the hub as a `database/query`
 * fn of its instance (`<instance>.<name>`, through `hub/fns_save`), so the next request finds it with `hub/fns_search`.
 * `get_query` and `edit_query` are authoring fns: the chat describes what it wants, and a query authoring agent on
 * `ctx.ai()` (`server/authoring.ts`) finds or writes the saved query through a forced workflow with progressive
 * disclosure, then it runs. The chat gets the saved fn and its run, never the working context. Rows go to the person as a
 * `result` attachment, which the app draws with its own result view (the table, value cards, the chart families and
 * any visual a system adds to the hub's `hub/visuals` registry, ranked by the columns' facts: a grouped key and its
 * aggregates, the table's key); the model gets a `ResultBlock` that says so. Writes and schema changes only run once a person approves them.
 */
import { ResultTable, type FnEffects } from '@harness/core';
import { attachment, context, fn, g, ginAs, hub, kind, system, type Infer } from '@harness/sdk';
import {
  ApplyArgs, AuthorArgs, CONFIG_SECRETS, DatabaseConfig, DatabasePick, DrillArgs, DatabaseSummary, PickArgs, InstanceAnswer, InstanceOp, ReadInstanceOp, ParamValues, QueryAgentAnswer, QueryAnswer, QueryPayload, QueryRun,
  type QueryHow,
  SchemaArgs, SchemaChanged, TableArgs, TableFnsArgs, TableFnsGenerateArgs, TableFnsGenerated, TableFnsList, TablesInfo,
} from './shapes.ts';

export * from './shapes.ts';

/** The query result attachment's data: core's `ResultTable`. */
export const ResultData = ginAs(ResultTable);

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

const RESULT_GUIDE = [
  'What comes back for a read: the columns, how many rows there are, and the first rows.',
  'When a person is watching, the app also shows them the rows (as a table or a chart) and the result\'s `shown` says so: don\'t copy the rows into your answer; say what matters in them.',
  'For more rows, call again with `offset` (and `limit`).',
  'A query that changes rows (insert, update, delete) does not run at once: the person sees an approval card and the call finishes when they approve or decline; until the result says it ran, nothing has changed, so never say it is done before that.',
].join(' ');

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

/** How a query's args are given: the tool schema can only say `any JSON` for them, so the words say it. */
const PARAM_VALUES_DOCS = 'An object of the values by param name, such as { "status": "paid" }: a JSON object, never a string holding JSON.';

/** A worked answer for the examples: the saved query's run for paid or open orders, with how and why. */
function exampleAnswer(how: QueryHow, why: string, status: string, rows: { id: number; total: number; customer: string }[], total: number, version = 1): QueryAnswer {
  const name = 'database/main.orders_by_status';
  const signature = `${name}(status: text, limit?: num, offset?: num, sort?: list<{ column: "total" | "customer", dir: "asc" | "desc" }>)`;
  return {
    database: { instance: 'main', label: 'Shop', dialect: 'sqlite' },
    fn: { name, signature, version, about: 'Orders with a given status and their customer, biggest first.', call: `${name}({"status":"${status}"})`, how, why },
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
  about: [
    'Databases: tables of rows that last, for anything the person wants to keep and look up again (expenses, chores, readings, a pantry, a reading list), and for questions about data already in a database.',
    'Its fns list the databases and their tables (database/databases, database/tables), find or write a query and run it (database/get_query, database/edit_query, database/run_query), make a table and change it (database/create_table, database/alter_table, which wait for the person\'s approval), and make a table\'s ready-made fns to add, change, remove, list, count and sum its rows (database/table_fns_available, database/table_fns_generate).',
    'It defines the fn kind `database/query`: every query it writes or generates is saved as a fn named `database/<database>.<name>` (such as `database/main.expenses_create`), which the person can run again by name later, in any chat; a search with kinds ["database/query"] finds the saved ones.',
    'Reach for it when the person wants a list or log of their own kept for later (make a table, then generate its fns), or asks about rows in a database. Not for one fact to recall later (a memory) or for asking the person questions (the input system\'s forms), though a form\'s answers can be saved into a table with its fns.',
    'Load the context item `database/guide` before the first use: it walks through making a table and its fns, with the exact shapes.',
  ].join(' '),
  // its API groups: the hub indexes its fns by them (`database/api`, `database/api.<group>`)
  groups: [
    { name: 'queries', title: 'Queries', description: 'Find, write, change and run saved queries: get_query for anything new, then call the saved query fn directly.' },
    { name: 'tables', title: 'Tables', description: 'The databases and their tables, and each table\'s ready-made fns (CRUD, counts, sums, relations).' },
    { name: 'schema', title: 'Schema', description: 'Create and change tables, and apply type changes a rescan found; every change waits for approval.' },
    { name: 'instances', title: 'Instances', description: 'Work forwarded to the instance that holds a database; called by this system\'s own tools only.' },
  ],
  configSecrets: [...CONFIG_SECRETS],
  // the query authoring agent and enrichment use models; writes and schema changes wait for approval; get_query asks
  // the decision model to pick a database; saved queries are hub fns it searches (the link's search), reads and saves
  grants: { hub: ['ai', 'approvals', 'decide', 'search', 'fns'], calls: ['hub/fns_get', 'hub/fns_save'] },
})
  .with({
    config: ginAs(DatabaseConfig),
    attachments: {
      result: attachment({ description: 'Rows a query read, drawn by the app\'s result view with the visuals that fit them (a table always).', data: ResultData }),
    },
    kinds: {
      query: kind({
        description: 'A saved query over one database, kept as a fn (`database/<database>.<name>`): running it reads rows, or, after the person approves, adds, changes or removes them. Its args are the query\'s params by name, plus `limit` / `offset` for a list and `sort` ([{ "column": "total", "dir": "desc" }]).',
        applicability: 'A question about the data in a database, or a change to it, that will come up again (overdue invoices, sales by month, log an expense). Made by database/get_query, database/edit_query or database/table_fns_generate, never written by hand.',
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
        group: 'instances',
        description: 'Do one query tool\'s work on this database instance (the tools forward here with `on` when another instance has the database).',
        instructions: 'Called by this system\'s own tools only.',
        args: ginAs(InstanceOp),
        returns: ginAs(InstanceAnswer),
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        examples: [{ args: { op: 'run', fn: 'database/main.orders_by_status', args: { status: 'paid' } }, note: 'Run a saved query on the instance it runs on.' }],
        visibility: 'none',
        display: 'hidden',
        effects: SAVES_QUERIES,
        // `read` lets the system's own tools call it without asking (the writes it forwards ask for themselves)
        tags: ['database', 'read'],
      }),
      read_at_instance: fn({
        group: 'instances',
        description: 'Do one reading query tool\'s work on this database instance: its tables, a draft\'s check, a table\'s generated fns (the read tools forward here with `on`).',
        instructions: 'Called by this system\'s own read tools only.',
        args: ginAs(ReadInstanceOp),
        returns: ginAs(InstanceAnswer),
        deps: { getFn: hub.fns.fns_get },
        examples: [{ args: { op: 'tables' }, note: 'The tables of the instance it runs on.' }],
        visibility: 'none',
        display: 'hidden',
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
      change_schema: fn({
        group: 'schema',
        description: 'Create or change a table from a row type on one database instance, once approved (create_table and alter_table forward here).',
        instructions: 'Called by create_table and alter_table, which say which instance; the person approves the DDL first.',
        args: ginAs(SchemaArgs),
        returns: ginAs(SchemaChanged),
        examples: [{ args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } } } }, action: 'create', database: 'main' } }],
        visibility: 'none',
        approval: { preview: true, remember: false },
        status: status('Changing {args.table}…', 'Changed {args.table}', 'Changing {args.table} failed'),
        // changes to one table in the same step run in the model's order (saved queries that write claim it too)
        parallelClaims: ['table:{args.table}'],
        effects: { mode: 'delete', free: true, registry: [{ thing: 'types', action: 'create' }, { thing: 'types', action: 'update' }, { thing: 'types', action: 'remove' }] },
        tags: ['database', 'schema', 'write'],
      }),
      apply_type_changes: fn({
        group: 'schema',
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
        group: 'queries',
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
        group: 'tables',
        description: 'The databases this system serves: each one\'s instance name (such as `main`, which other database fns take as `database`), its label for people, and its tables.',
        instructions: 'Call it first when you don\'t know which database to use, or whether a table for the request exists already. It takes no args: {}. Only databases the person may use are listed. An empty `tables` list means the database has no tables yet: make one with database/create_table.',
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
        group: 'tables',
        description: 'One database\'s tables in full: each table\'s columns with their types, choices, formats and ranges, and the relations between tables.',
        instructions: 'Call it to see what a database holds before you describe a query, change a table, or tell the person what is there. `database` is the instance name from database/databases (`main`). Describe queries only in terms of the tables and columns it lists.',
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
      drill_down: fn({
        group: 'queries',
        description: 'The rows behind one group of a saved grouped query\'s result (a bar, a slice, a grouped row clicked), a page at a time: the query un-ravelled by @aeye/query\'s drillDown, each group key pinned to the clicked value.',
        instructions: 'Called by the app when a person clicks a part of a result that stands for a group; the result says it can be drilled (`drill`) with the fn and args to pass.',
        args: ginAs(DrillArgs),
        returns: ResultData,
        deps: { at: fns.read_at_instance },
        examples: [{ args: { fn: 'database/main.orders_per_status', args: {}, group: { status: 'paid' } }, note: 'The paid orders behind the "paid" bar.' }],
        // the person's click runs it, never the model: it takes a result's group, not a request
        visibility: 'user',
        routing: { to: 'any' },
        effects: { mode: 'read', free: true },
        tags: ['database', 'read'],
      }),
      table_fns_available: fn({
        group: 'tables',
        description: 'Every fn that could be generated for a table, grouped (CRUD, column helpers, the whole table, and each relation), the most useful first: its name, what it does, its signature, whether it writes, and whether it exists already (with its version).',
        instructions: 'Use it right after making a table, and whenever the person wants to add, change, remove, list, count or total the rows of one table: these ready-made fns (create, update, remove, selectPage, counts, sums, a parent\'s child counts, a row\'s rank among its siblings) are simpler and safer than a query written for the purpose. `table` is the table\'s name (`expenses`, with `database` when there are several databases) or its type (`database/main.expenses`). It only lists them: pass the `name`s you want to database/table_fns_generate to make them. One already made (state `current`) is a fn you can call by its `fn` name now; `stale` means the table changed since it was made: generate it again.',
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
        group: 'tables',
        description: 'Make (or bring up to date) some of a table\'s ready-made fns, by the names database/table_fns_available lists, as saved query fns of its database. Unchanged ones are left as they are; changed ones get a new version.',
        instructions: 'Give `table` (as for table_fns_available) and `names` exactly as table_fns_available listed them (such as ["create", "update", "remove", "selectPage"]). The answer lists each fn made with its full name and signature (`database/main.expenses_create(amount: num, …)`): those are new fns, so load them before you call them, then call each by that name with the args its signature shows (or run it with database/run_query). A fn that writes (create, update, remove) waits for the person\'s approval every time it runs. `derived` adds derived fields (projectCount) to selectPage, to show, sort and filter on.',
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
        group: 'queries',
        description: 'Run a saved query fn (`database/<database>.<name>`) by its name with its args, without loading it into your tools first. A read gives you its rows; a write waits for the person\'s approval.',
        instructions: [
          '`fn` is the saved query\'s full name, as a search, get_query or table_fns_generate gave it.',
          '`args` is ONE JSON object holding the query\'s params by name, exactly as its signature lists them: `database/main.orders_by_status(status: text, limit?: num, offset?: num, sort?: …)` takes {"status": "paid"}.',
          'Never a list, never a string holding JSON; leave out the params you don\'t need (those marked ? are optional), and leave `args` out only when the query has no required params.',
          '`sort` is a list of {"column": <a column>, "dir": "asc" or "desc"}.',
          'If the result says the input was invalid, it names the param that was wrong: fix that one and call again.',
          RESULT_GUIDE,
        ].join(' '),
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
      author_query: fn({
        group: 'queries',
        description: 'Find or write the saved query for a request on this database instance with the query authoring agent, keep it, and run it (get_query and edit_query forward here with on).',
        instructions: 'Called by get_query and edit_query only: they pick the database and forward the request (and, for an edit, the saved query).',
        args: ginAs(AuthorArgs),
        returns: ginAs(QueryAnswer),
        deps: { getFn: hub.fns.fns_get, saveFn: hub.fns.fns_save },
        examples: [{ args: { request: 'Paid orders, biggest first, with the customer.' } }, { args: { request: 'Also show the order date.', edit: 'database/main.orders_by_status' } }],
        visibility: 'none',
        display: 'hidden',
        status: status('Writing a query…', 'Wrote a query', 'Writing a query failed'),
        effects: SAVES_QUERIES,
        tags: ['database', 'query'],
      }),
    },
  }))
  .with(({ fns }) => ({
    fns: {
      get_query: fn({
        group: 'queries',
        description: 'Read or change data in a database by describing what you want in words: a saved query that already does it is reused, or a new one is written, saved as a fn, and run once with the values you gave.',
        instructions: [
          'Use it when no saved query you know of does the job (search first, with kinds ["database/query"]).',
          '`detailedDescription` says in plain words: which table(s), which rows (the filters), which columns, any grouping or totals, the order, and this request\'s values, saying which ones should be params that vary next time.',
          'Examples: "expenses between a start date and an end date, newest first; this time from 2026-11-01 to 2026-11-30"; "total spent per category between two dates"; "add one expense: amount, category and the day; this time 12.50, food, 2026-11-22".',
          'For a time window name both ends, and check the result: a query that only says "on or after" today finds nothing from the past.',
          'To add, change or remove rows of one table, its ready-made fns (database/table_fns_available) are often simpler.',
          'The answer names the saved query\'s fn and its signature: next time call that fn (or database/run_query with it) instead of asking get_query again.',
          RESULT_GUIDE,
          'When the answer asks which database, do what its "next" says. If it fails, read the reason: a missing table or column means the table must be made or changed first (create_table / alter_table); don\'t send the same request again.',
        ].join(' '),
        args: QueryArgs,
        returns: ginAs(QueryAgentAnswer),
        deps: { author: fns.author_query },
        examples: [
          {
            args: { detailedDescription: "Paid orders, biggest total first, with the customer's name.", database: 'main' },
            result: exampleAnswer('created', 'No saved query listed orders by status, so one was written with the status as a param.', 'paid', [{ id: 7, total: 940, customer: 'Ada' }, { id: 3, total: 410, customer: 'Bo' }], 2),
          },
          {
            args: { detailedDescription: 'Open orders, biggest first, with the customer.' },
            result: exampleAnswer('reused', 'The saved orders_by_status query does this with status "open".', 'open', [{ id: 9, total: 120, customer: 'Cy' }], 1),
          },
          { args: { detailedDescription: 'Total sales per month in 2025, by month.' }, note: 'A grouped query with the year as a param.' },
          { args: { detailedDescription: 'Add one row to the expenses table: the amount, the category and the day it was spent, all as params; this time 12.50, food, 2026-11-22.', database: 'main' }, note: 'An insert: it is saved as a fn and waits for the person\'s approval each time it runs.' },
          { args: { detailedDescription: 'Expenses spent between a start date and an end date, newest first, with amount, category and day; this time from 2026-10-23 to 2026-11-22.', database: 'main' }, note: '"The last 30 days" as two date params, so both ends are checked.' },
          {
            args: { detailedDescription: 'Every invoice that is overdue.' },
            result: { ask: 'Which database: Shop or Billing?', databases: ['main', 'billing'], next: 'Ask the person with input/ask_choice (question "Which database: Shop or Billing?", options "Shop" and "Billing"), end your turn, then call get_query again with the database they pick.' },
            note: 'Two databases could hold invoices, the request does not say which, and the decision model could not tell.',
          },
        ],
        status: status('Finding a query…', 'Queried the database', 'The query failed'),
        // the decision model it may ask and the authoring agent are model calls of the run; it keeps the query it writes
        effects: SAVES_QUERIES,
        routing: { to: 'any' },
        tags: ['database', 'query'],
      }),
      edit_query: fn({
        group: 'queries',
        description: 'Change a saved query fn by instructions (add a column, another filter, a different order). The old version is kept in its history; the new one is saved under the same name and run.',
        instructions: `\`name\` is the saved query's full name (\`database/main.orders_by_status\`); \`instructions\` says exactly what to change and the values to run it with this time. Use it when a saved query is close but not right, rather than writing a second one with get_query. ${RESULT_GUIDE}`,
        args: EditArgs,
        returns: ginAs(QueryAnswer),
        deps: { author: fns.author_query },
        examples: [{
          args: { name: 'database/main.orders_by_status', instructions: 'Also show the order date, newest first; run it for paid orders.' },
          result: exampleAnswer('edited', 'Added the order date and ordered by it, newest first; version 2.', 'paid', [{ id: 7, total: 940, customer: 'Ada' }, { id: 3, total: 410, customer: 'Bo' }], 2, 2),
        }],
        status: status('Editing {args.name}…', 'Edited {args.name}', 'Editing {args.name} failed'),
        effects: SAVES_QUERIES,
        routing: { to: 'any' },
        tags: ['database', 'query'],
      }),
      create_table: fn({
        group: 'schema',
        description: 'Make a new table in a database from a row type: a description of its columns. Runs only after the person approves it (they see the SQL that will run).',
        instructions: [
          'Use it when the person wants to keep a new kind of list or log (expenses, chores, readings) and no table for it exists yet (check with database/databases).',
          '`table`: the new table\'s name, lowercase with underscores (`expenses`). `database`: the instance name (`main`); leave it out when there is only one.',
          '`type` is the row type, always in this shape: {"name": "obj", "props": {<column>: {"type": <column type>}, …}}. Its "name" is always the word "obj", never the table\'s name, and each column is an object holding its type under "type", never the type itself.',
          'Column types: {"name": "text"}; {"name": "num"} (any number); {"name": "num", "options": {"whole": true}} (a whole number); {"name": "bool"}; {"name": "date"}; {"name": "timestamp"} (a date and time);',
          'a fixed set of choices {"name": "enum", "generic": {"V": {"name": "text"}}, "options": {"values": {"food": "food", "rent": "rent"}}}; and a column that may be left empty {"name": "optional", "generic": {"T": <column type>}}.',
          'Give an `id` column of whole numbers: it becomes the key, filled in by itself for each new row.',
          'Worked example, an expenses table: {"table": "expenses", "type": {"name": "obj", "props": {"id": {"type": {"name": "num", "options": {"whole": true}}}, "amount": {"type": {"name": "num"}}, "category": {"type": {"name": "enum", "generic": {"V": {"name": "text"}}, "options": {"values": {"food": "food", "rent": "rent", "other": "other"}}}}, "spent_on": {"type": {"name": "date"}}, "note": {"type": {"name": "optional", "generic": {"T": {"name": "text"}}}}}}}.',
          'Say in a sentence what table you will make before calling; the call waits for the person\'s approval and nothing exists until it comes back.',
          'What comes back: the database, the SQL steps that ran, and the table types now in the hub (`database/main.expenses`). Next, make the table\'s fns: database/table_fns_available, then database/table_fns_generate.',
          'If it is refused (the database allows no schema changes, the table exists already, a type it can\'t read), tell the person the reason it gives; to change an existing table use database/alter_table.',
        ].join(' '),
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        approval: { preview: true, remember: false },
        examples: [
          { args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } } }, note: 'A whole-number id, a text column, and a date that may be empty.' },
          {
            args: {
              table: 'expenses',
              database: 'main',
              type: {
                name: 'obj',
                props: {
                  id: { type: { name: 'num', options: { whole: true } } },
                  amount: { type: { name: 'num' } },
                  category: { type: { name: 'enum', generic: { V: { name: 'text' } }, options: { values: { food: 'food', rent: 'rent', other: 'other' } } } },
                  spent_on: { type: { name: 'date' } },
                  note: { type: { name: 'optional', generic: { T: { name: 'text' } } } },
                },
              },
            },
            note: 'An expenses log: an amount, a category from fixed choices, the day it was spent and an optional note.',
          },
        ],
        status: status('Creating {args.table}…', 'Created {args.table}', 'Creating {args.table} failed'),
        // changes to one table in the same step run in the model's order (saved queries that write claim it too)
        parallelClaims: ['table:{args.table}'],
        effects: { mode: 'write', free: true, registry: [{ thing: 'types', action: 'create' }] },
        tags: ['database', 'schema', 'write'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
      alter_table: fn({
        group: 'schema',
        description: 'Change an existing table to match a row type: add, drop and change columns. Runs only after the person approves the steps.',
        instructions: [
          'Give `table` and the WHOLE row type as the table should be afterwards, in the same shape as database/create_table ({"name": "obj", "props": {<column>: {"type": <column type>}}}): every column you keep, plus the new ones.',
          'A column left out is dropped; dropping or narrowing a column can lose data, and the approval marks it so. Read the current columns first with database/tables.',
          'A column added to a table that has rows should be optional ({"name": "optional", "generic": {"T": …}}).',
          'Saved queries that read a narrowed table may break; the approval lists them. It waits for the person\'s approval, then gives the SQL steps that ran.',
          'Afterwards, generate the table\'s fns again (database/table_fns_generate) so they know the new columns.',
        ].join(' '),
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        approval: { preview: true, remember: false },
        examples: [
          { args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } }, done: { type: { name: 'bool' } } } } }, note: 'Adds `done`, drops `due`.' },
          {
            args: {
              table: 'expenses',
              type: {
                name: 'obj',
                props: {
                  id: { type: { name: 'num', options: { whole: true } } },
                  amount: { type: { name: 'num' } },
                  spent_on: { type: { name: 'date' } },
                  note: { type: { name: 'optional', generic: { T: { name: 'text' } } } },
                  shop: { type: { name: 'optional', generic: { T: { name: 'text' } } } },
                },
              },
            },
            note: 'Keeps every column it lists and adds an optional `shop`, which existing rows leave empty (a column it leaves out, like `category`, is dropped).',
          },
        ],
        status: status('Changing {args.table}…', 'Changed {args.table}', 'Changing {args.table} failed'),
        // changes to one table in the same step run in the model's order (saved queries that write claim it too)
        parallelClaims: ['table:{args.table}'],
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
        description: 'How to keep a list or log of the person\'s own in a database table, and how to read and change data in the databases.',
        content: [
          '# Databases',
          '',
          'A database holds tables of rows that last. Each table is also a type in the hub (`database/<database>.<table>`, such as `database/main.expenses`), and every query is kept as a fn of the kind `database/query`, named `database/<database>.<name>`, so it can be run again later by name.',
          '',
          '## Keeping something new (expenses, chores, readings, a pantry)',
          '',
          '1. Call database/databases ({}) to see the databases (their instance names, such as `main`) and the tables they have. If a fitting table exists, skip to step 3.',
          '2. Call database/create_table with the table\'s name and its row type. The row type is always {"name": "obj", "props": {<column>: {"type": <column type>}}}: "name" is the word "obj", and each column holds its type under "type". For example:',
          '   {"table": "chores", "type": {"name": "obj", "props": {"id": {"type": {"name": "num", "options": {"whole": true}}}, "chore": {"type": {"name": "text"}}, "who": {"type": {"name": "optional", "generic": {"T": {"name": "text"}}}}, "due": {"type": {"name": "date"}}, "done": {"type": {"name": "bool"}}}}}',
          '   Column types: text, num (add "options": {"whole": true} for whole numbers), bool, date, timestamp, enum for fixed choices ({"name": "enum", "generic": {"V": {"name": "text"}}, "options": {"values": {"a": "a", "b": "b"}}}), and optional ({"name": "optional", "generic": {"T": …}}) for a column that may be empty. A whole-number `id` is the key and fills itself in.',
          '   The call waits for the person to approve; say what you are making and don\'t say it exists until the result comes back.',
          '3. Call database/table_fns_available with the table (`database/main.chores`) to see its ready-made fns, then database/table_fns_generate with the names you need, usually ["create", "update", "remove", "selectPage"]. They are saved fns such as `database/main.chores_create`.',
          '4. Load the new fns (they are not in your tools yet) and call them with the args the signature table_fns_generate gave shows. `database/main.chores_create` adds a row (its args are the columns, such as {"chore": "Bins out", "due": "2026-11-24", "done": false}); `database/main.chores_selectPage` lists rows. Or run any of them without loading with database/run_query {"fn": "database/main.chores_create", "args": {…}}.',
          '',
          '## Reading and changing data',
          '',
          '- Search for a saved query first (kinds ["database/query"]); when one fits, call it with its params.',
          '- Else call database/get_query with a detailed description in words (tables, filters, columns, grouping, order, and this time\'s values). It reuses or writes a query, saves it and runs it. For a time window give both ends ("between a start date and an end date").',
          '- database/edit_query changes a saved query that is close but not right.',
          '- database/alter_table changes a table\'s columns: give the whole row type as it should be afterwards.',
          '',
          '## What to expect',
          '',
          RESULT_GUIDE,
          'Making or changing a table, and every query that writes, wait for the person\'s approval each time. If something is refused, tell the person the reason it gives.',
          'To draw rows as a chart to keep, see the widgets system (widgets/make_widget); never draw a chart yourself.',
        ].join('\n'),
        fns: [fns.databases, fns.tables, fns.get_query, fns.edit_query, fns.run_query, fns.table_fns_available, fns.table_fns_generate, fns.create_table, fns.alter_table],
        tags: ['database'],
      }),
    },
  }));

/** The database contract's type. */
export type DatabaseContract = typeof database;
/** The query result attachment's data. */
export type ResultDataValue = Infer<typeof ResultData>;
