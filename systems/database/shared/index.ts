/**
 * The database system's contract (`shared/`). One instance per database (SQLite, Postgres or SQL Server). Every table
 * is a type in the hub (`<instance>.<table>`); every query the chat asks for is kept in the hub as a `database/query`
 * fn of its instance (`<instance>.<name>`, through `hub/save_fn`), so the next request finds it with `hub/fns_search`.
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
  ApplyArgs, AuthorArgs, CONFIG_SECRETS, DatabaseConfig, DatabasePick, DatabaseSummary, PickArgs, InstanceAnswer, InstanceOp, ReadInstanceOp, ParamValues, QueryAgentAnswer, QueryAnswer, QueryPayload, QueryRun,
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
  grants: { hub: ['ai', 'approvals', 'decide', 'search', 'fns'], calls: ['hub/fn_get', 'hub/save_fn'] },
})
  .with({
    config: ginAs(DatabaseConfig),
    attachments: {
      result: attachment({ description: 'Rows a query read, drawn by the app\'s result view with the visuals that fit them (a table always).', data: ResultData }),
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
        group: 'instances',
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
        group: 'instances',
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
        group: 'schema',
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
        group: 'tables',
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
      table_fns_available: fn({
        group: 'tables',
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
        group: 'tables',
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
        group: 'queries',
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
      author_query: fn({
        group: 'queries',
        description: 'Find or write the saved query for a request on this database instance with the query authoring agent, keep it, and run it (get_query and edit_query forward here with on).',
        instructions: 'Called by get_query and edit_query only: they pick the database and forward the request (and, for an edit, the saved query).',
        args: ginAs(AuthorArgs),
        returns: ginAs(QueryAnswer),
        deps: { getFn: hub.fns.fn_get, saveFn: hub.fns.save_fn },
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
        description: 'Read or change data in a database: describe in detail what you want, and a saved query that does it is reused, or a new one is written, kept and run.',
        instructions: `Say which rows, columns, filters, grouping and order you want, and any values (as params, e.g. "for a customer given by name"). The answer names the query's fn and how to call it: call it directly next time. ${RESULT_GUIDE} A write (insert, update, delete) waits for the person to approve it. When the answer asks which database, do what its "next" says.`,
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
        description: 'Change a saved query fn by instructions (add a column, another filter, a different order). The old version is kept; the new one runs.',
        instructions: `Name the saved query fn and say exactly what to change and the values to run it with. ${RESULT_GUIDE}`,
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
        description: 'Make a table from a row type (on a database whose schema may change). Runs only after the person approves the DDL.',
        instructions: 'Give the table name and the row type, a gin obj type whose props are the columns; `id` is the primary key. Say what it is for; the person sees the DDL before it runs.',
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        approval: { preview: true, remember: false },
        examples: [
          { args: { table: 'notes', type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } } }, note: 'A whole-number id, a text column, and a date that may be empty.' },
        ],
        status: status('Creating {args.table}…', 'Created {args.table}', 'Creating {args.table} failed'),
        effects: { mode: 'write', free: true, registry: [{ thing: 'types', action: 'create' }] },
        tags: ['database', 'schema', 'write'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
      alter_table: fn({
        group: 'schema',
        description: 'Change a table to match a row type: add, drop and change columns (on a database whose schema may change). Runs only after the person approves the steps.',
        instructions: 'Give the whole row type as it should be; dropping a column or narrowing one can lose data and is marked so in the approval.',
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        approval: { preview: true, remember: false },
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
