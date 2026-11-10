/**
 * The database system's contract (`shared/`). One instance per database (SQLite, Postgres or SQL Server). Every table
 * is a type in the hub (`<instance>.<table>`); every query the chat asks for is kept as a `database/query` fn of its
 * instance (`<instance>.<name>`), so `get_query` finds and reuses it next time. Rows go to the person as a `result`
 * attachment, drawn by the best fitting visual of the `query-visuals` registry; the model gets a `ResultBlock` that
 * says so. Writes and schema changes only run once a person approves them.
 */
import { ResultTable } from '@harness/core';
import { attachment, context, fn, g, ginAs, kind, system, type Infer } from '@harness/sdk';
import { ApplyArgs, CONFIG_SECRETS, DatabaseConfig, QueryAnswer, QueryPayload, SchemaArgs, SchemaChanged, TableArgs } from './shapes.ts';

export * from './shapes.ts';

/** The query result attachment's data: core's `ResultTable`. */
export const ResultData = ginAs(ResultTable);

/** The query visuals registry, by local name and qualified. */
export const VISUALS = 'query-visuals';
export const VISUALS_REGISTRY = `database/${VISUALS}` as const;

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
  name: g.field(g.text({ minLength: 1 }), { docs: 'The query fn (`database/main.overdue_invoices` or `main.overdue_invoices`).' }),
  instructions: g.field(g.text({ minLength: 1 }), { docs: 'What to change, and the values to run it with.' }),
});

const RESULT_GUIDE = 'The rows are shown to the person (as a table or another visual); you get the columns, counts and the first rows. Don\'t repeat the rows: summarize or point out what matters. Page with `limit` and `offset`.';

/** The database system's contract. */
export const database = system('database', {
  description: 'Query and change SQL databases (SQLite, Postgres, SQL Server): every table is a type, and every query asked for is kept as a fn for next time.',
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
      query_on: fn({
        description: 'get_query on one database instance (get_query forwards here).',
        args: QueryArgs,
        returns: ginAs(QueryAnswer),
        visibility: 'none',
        status: status('Finding a query…', 'Ran {output.fn.name}', 'The query failed'),
        tags: ['database', 'query'],
      }),
      edit_on: fn({
        description: 'edit_query on one database instance (edit_query forwards here).',
        args: EditArgs,
        returns: ginAs(QueryAnswer),
        visibility: 'none',
        status: status('Editing {args.name}…', 'Edited {args.name}', 'Editing {args.name} failed'),
        tags: ['database', 'query'],
      }),
      change_schema: fn({
        description: 'Create or change a table from a row type on one database instance, once approved (create_table and alter_table forward here).',
        args: ginAs(SchemaArgs),
        returns: ginAs(SchemaChanged),
        visibility: 'none',
        approval: { preview: true, remember: false },
        status: status('Changing {args.table}…', 'Changed {args.table}', 'Changing {args.table} failed'),
        tags: ['database', 'schema', 'write'],
      }),
      apply_type_changes: fn({
        description: 'Apply the table type changes a rescan found that would break saved queries or drop a type. Proposed by the system for an admin to approve.',
        args: ginAs(ApplyArgs),
        returns: ginAs(SchemaChanged),
        visibility: 'user',
        status: status('Applying type changes…', 'Applied type changes', 'Applying type changes failed'),
        tags: ['database', 'schema'],
      }),
    },
  })
  .with(({ fns }) => ({
    fns: {
      get_query: fn({
        description: 'Read or change data in a database: describe in detail what you want, and a saved query that does it is reused, or a new one is written, kept and run.',
        instructions: `Say which rows, columns, filters, grouping and order you want, and any values (as params, e.g. "for a customer given by name"). The answer has the query's fn and signature: call that fn directly next time. ${RESULT_GUIDE} A write (insert, update, delete) waits for the person to approve it.`,
        args: QueryArgs,
        returns: ginAs(QueryAnswer),
        deps: { query_on: fns.query_on },
        status: status('Finding a query…', 'Ran {output.fn.name}', 'The query failed'),
        tags: ['database', 'query'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
      edit_query: fn({
        description: 'Change a saved query fn by instructions (add a column, another filter, a different order). The old version is kept; the new one runs.',
        instructions: RESULT_GUIDE,
        args: EditArgs,
        returns: ginAs(QueryAnswer),
        deps: { edit_on: fns.edit_on },
        status: status('Editing {args.name}…', 'Edited {args.name}', 'Editing {args.name} failed'),
        tags: ['database', 'query'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
      create_table: fn({
        description: 'Make a table from a row type (on a database whose schema may change). Runs only after the person approves the DDL.',
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
        status: status('Creating {args.table}…', 'Created {args.table}', 'Creating {args.table} failed'),
        tags: ['database', 'schema', 'write'],
        // any instance answers: it picks the database and forwards there with `on`
        routing: { to: 'any' },
      }),
      alter_table: fn({
        description: 'Change a table to match a row type: add, drop and change columns (on a database whose schema may change). Runs only after the person approves the steps.',
        args: ginAs(TableArgs),
        returns: ginAs(SchemaChanged),
        deps: { change_schema: fns.change_schema },
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
