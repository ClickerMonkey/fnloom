/**
 * The database system's shapes, zod first: its config, the query kind's payload, and everything its fns hand the
 * model. The contract (`index.ts`) carries each as gin (`ginAs`), and the server parses with these, so each shape has
 * one source.
 */
import { GinTypeDef, Json, ShareRule } from '@harness/core';
import { ResultBlock, ResultFn } from '@harness/sdk';
import { z } from 'zod';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * A connection with exactly the fields its kind needs: a new SQLite file in the instance's data folder, an existing
 * SQLite file, Postgres or SQL Server. The config form shows one kind at a time, labelled by its `kind` description,
 * with only that kind's fields; each secret (`url`, `password`) still has one path.
 */
export const Connection = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sqlite-new').describe('New SQLite file'),
    path: z.string().min(1).regex(/^[^/\\:]+$/, 'A new SQLite file is a plain file name inside the data folder.').describe("A file name inside the instance's data folder (`shop.db`)."),
  }),
  z.object({
    kind: z.literal('sqlite-file').describe('Existing SQLite file'),
    path: z.string().min(1).describe("The SQLite file's full path."),
  }),
  z.object({
    kind: z.literal('postgres').describe('Postgres'),
    url: z.string().min(1).describe('The connection URL (`postgres://user:password@host:5432/db`). Kept as a secret.'),
  }),
  z.object({
    kind: z.literal('sqlserver').describe('SQL Server'),
    host: z.string().min(1).describe('The host name.'),
    port: z.number().int().min(1).max(65535).optional().describe('The port (1433 when empty).'),
    database: z.string().min(1).describe('The database name.'),
    user: z.string().min(1).describe('The user name.'),
    password: z.string().min(1).describe('The password. Kept as a secret.'),
    encrypt: z.boolean().optional().describe('Encrypt the connection (on when empty).'),
  }),
]);
export type Connection = z.infer<typeof Connection>;

/** The kinds of connection. */
export type ConnectionKind = Connection['kind'];

/** The dialects the system speaks, by connection kind. */
export const DIALECT_NAMES = ['sqlite', 'postgres', 'sqlserver'] as const;
export const DialectName = z.enum(DIALECT_NAMES);
export type DialectName = z.infer<typeof DialectName>;

/** The dialect a connection speaks. */
export function dialectOf(kind: ConnectionKind): DialectName {
  return kind === 'sqlite-new' || kind === 'sqlite-file' ? 'sqlite' : kind;
}

/** One instance's config: one database. */
export const DatabaseConfig = z.object({
  label: z.string().min(1).describe('What this database is, as people and the model read it ("Shop orders").'),
  connection: Connection,
  data: z.enum(['read-only', 'read-write']).describe('`read-write` lets queries insert, update and delete rows, each only after the person approves it.'),
  schema: z.enum(['none', 'allowed']).describe('`allowed` lets the chat create and change tables from types, each only after approval.'),
  enrich: z.object({
    on: z.boolean().describe('Have a model refine each table\'s type (choices, formats, ranges, descriptions) when its schema changes.'),
    model: z.string().min(1).optional().describe('The model for it (`openrouter/...`); the hub\'s default when empty.'),
  }),
  audience: ShareRule.describe('Who may use this database\'s query fns.'),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfig>;

/** The config's secret fields. */
export const CONFIG_SECRETS = ['connection.url', 'connection.password'] as const;

// ─── The query kind ──────────────────────────────────────────────────────────

/** How a generated fn's query is built (`@aeye/query`'s `TableFnOp`, which `toTableFnOp` turns it back into): JSON, so it is stored and rebuilt. */
export const TableFnOpSchema = z.object({
  kind: z.enum([
    'create', 'update', 'updateWhere', 'remove', 'removeWhere', 'selectOne', 'selectPage',
    'countBy', 'stats', 'buckets', 'exists', 'findOrCreate', 'childrenOf', 'countPerParent', 'derived',
  ]),
  table: z.string().min(1),
  column: z.string().min(1).optional(),
  child: z.string().min(1).optional(),
  bucket: z.enum(['day', 'week', 'month']).optional(),
  derived: z.array(z.string().min(1)).optional(),
});
export type TableFnOpValue = z.infer<typeof TableFnOpSchema>;

/** What a generated query fn was made from: its op, and the hash of its table's schema then. */
export const GeneratedFrom = z.object({
  op: TableFnOpSchema,
  hash: z.string().min(1).describe('The table schema hash (`tableSchemaHash`) it was generated for.'),
});
export type GeneratedFrom = z.infer<typeof GeneratedFrom>;

/** A saved query: an `@aeye/query` query over this database's table types, and how callers may page and sort it. */
export const QueryPayload = z.object({
  /** The database instance it runs on. */
  instance: z.string().min(1),
  /** What it answers, in words: what the model matches later requests against. */
  description: z.string().min(1),
  /** The query, as `@aeye/query` JSON (`{ kind: 'select', … }`). */
  query: Json,
  /** Output columns a caller may sort by (`sort` arg); empty for none. */
  sorters: z.array(z.string().min(1)),
  /** Whether it returns a list of rows that pages with `limit` / `offset`. */
  list: z.boolean(),
  /** Params a caller may leave out, bound as NULL (no filter, no change); every other param is required. */
  optional: z.array(z.string().min(1)).optional(),
  /** Set when `table_fns_generate` made it: what it was generated from, so it is rebuilt when the table changes. */
  generated: GeneratedFrom.optional(),
});
export type QueryPayload = z.infer<typeof QueryPayload>;

/** A sort a caller asks for. */
export const SortArg = z.array(z.object({ column: z.string().min(1), dir: z.enum(['asc', 'desc']) }));
export type SortArg = z.infer<typeof SortArg>;

// ─── What the model reads ────────────────────────────────────────────────────

/** What a write did once approved. */
export const WriteResult = z.object({
  shown: z.string(),
  affected: z.number().int().min(0).describe('Rows inserted, changed or deleted.'),
  returned: ResultBlock.optional().describe('Rows the write returned (`returning`), when it asked for any.'),
});
export type WriteResult = z.infer<typeof WriteResult>;

/** The database a fn ran on. */
export const DatabaseInfo = z.object({ instance: z.string(), label: z.string(), dialect: DialectName });
export type DatabaseInfo = z.infer<typeof DatabaseInfo>;

/** How a query was come by. */
export const QueryHow = z.enum(['reused', 'created', 'edited']);
export type QueryHow = z.infer<typeof QueryHow>;

/** Where a write or schema change stands with its approval. */
export const ApprovalState = z.object({
  run: z.string().describe('The run waiting for approval.'),
  state: z.enum(['waiting', 'approved', 'declined']),
  says: z.string().describe('What happens now, in words.'),
});
export type ApprovalState = z.infer<typeof ApprovalState>;

/** A query's param values, by param name (`{ "status": "paid" }`). */
export const ParamValues = z.record(z.string(), Json);
export type ParamValues = z.infer<typeof ParamValues>;

/** What `run_query` gives: the database, the fn, the query as it ran, and its result or where its approval is. */
export const QueryRun = z.object({
  database: DatabaseInfo,
  fn: ResultFn,
  query: z.object({
    sql: z.string().describe('The SQL it runs, readable.'),
    structured: Json.describe('The `@aeye/query` JSON, to change it with edit_query.'),
    params: ParamValues.describe('The values it ran with.'),
    writes: z.boolean(),
  }),
  result: ResultBlock.optional(),
  approval: ApprovalState.optional(),
});
export type QueryRun = z.infer<typeof QueryRun>;

// ─── The query agent's tools ─────────────────────────────────────────────────

/** A query the agent wrote, before it is checked and saved. */
export const QueryDraft = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/).describe('A snake_case name (`overdue_invoices`); it is saved as `database/<database>.<name>`.'),
  title: z.string().min(1).describe('A short title (`Overdue invoices`).'),
  description: z.string().min(1).describe('One sentence: what it returns (or changes) and what its params are for. Later requests are matched against it.'),
  query: Json.describe('The query as `@aeye/query` JSON (`{ "kind": "select", … }`).'),
  sorters: z.array(z.string().min(1)).optional().describe('Output columns a caller may sort by.'),
});
export type QueryDraft = z.infer<typeof QueryDraft>;

/** What `check_query` says about a draft: whether it runs here, its SQL and signature, or what to fix. */
export const QueryCheck = z.object({
  ok: z.boolean(),
  problems: z.array(z.string()).describe('Each problem, with what to change; empty when `ok`.'),
  sql: z.string().optional().describe('The SQL it would run.'),
  signature: z.string().optional().describe('The fn it would be, as one line: its args and what it returns.'),
  writes: z.boolean().optional(),
});
export type QueryCheck = z.infer<typeof QueryCheck>;

/** What `tables` gives: one database's tables, columns and relations, and the query language, as the agent writes against. */
export const TablesInfo = z.object({
  database: DatabaseInfo,
  writes: z.boolean().describe('Whether queries may insert, update and delete (each after approval).'),
  schema: z.string().describe('The table types, their columns (with choices, formats and ranges where known), relations, and how to write queries.'),
});
export type TablesInfo = z.infer<typeof TablesInfo>;

/** A query `save_query` kept in the hub. */
export const SavedQueryRef = z.object({
  fn: z.string().describe('The saved fn (`database/main.overdue_invoices`).'),
  signature: z.string(),
  version: z.number().int().min(1).describe('1 for a new query; more when an edit replaced an earlier version (kept in its history).'),
  created: z.boolean(),
});
export type SavedQueryRef = z.infer<typeof SavedQueryRef>;

/** One database as `databases` lists it. */
export const DatabaseSummary = z.object({
  instance: z.string(),
  label: z.string(),
  tables: z.array(z.string()).describe('Its tables, each with what it holds when known.'),
});
export type DatabaseSummary = z.infer<typeof DatabaseSummary>;

/**
 * The query fn an authoring fn answered with (`get_query`, `edit_query`): the SDK's authored-fn answer (its version,
 * what it does, how to call it again) with its name and signature as a result names them, and how it was come by.
 */
export const QueryAnswerFn = ResultFn.extend({
  version: z.number().int().min(1).describe('1 for a new query; more after edits (the old versions are kept).'),
  about: z.string().describe('What it returns or changes, in one sentence.'),
  call: z.string().describe('How to call it again directly, with the args of this request.'),
  how: QueryHow,
  why: z.string().min(1).describe('Why this query: the saved one that fit, or what was written or changed.'),
});
export type QueryAnswerFn = z.infer<typeof QueryAnswerFn>;

/**
 * What `get_query` and `edit_query` answer with: the saved query's run (the database, the query as it ran, and its
 * result or where its approval is) and its fn with how and why. Never the authoring agent's working context.
 */
export const QueryAnswer = QueryRun.extend({ fn: QueryAnswerFn });
export type QueryAnswer = z.infer<typeof QueryAnswer>;

/** `get_query`'s answer when the request could be for more than one database and doesn't say which. */
export const AskWhichDatabase = z.object({
  ask: z.string().min(1).describe('The question for the person: which database they mean, by label.'),
  databases: z.array(z.string().min(1)).min(2).describe('The database instances it could be.'),
});
export type AskWhichDatabase = z.infer<typeof AskWhichDatabase>;

/** `get_query`'s question back when the database is unclear: which one, and what the caller does now. */
export const AskDatabase = AskWhichDatabase.extend({
  next: z.string().describe('What to do now: ask the person with input/ask_choice and call get_query again with their pick (or, with nobody watching, say which databases could answer).'),
});
export type AskDatabase = z.infer<typeof AskDatabase>;

/** What `get_query` answers: the query it ran, or which database to use. */
export const QueryAgentAnswer = z.union([QueryAnswer, AskDatabase]);
export type QueryAgentAnswer = z.infer<typeof QueryAgentAnswer>;

/** A table made or changed from a type (`create_table`, `alter_table`, `apply_type_changes`). */
export const SchemaChanged = z.object({
  database: DatabaseInfo,
  shown: z.string(),
  steps: z.array(z.object({ sql: z.string(), irreversible: z.boolean() })),
  types: z.array(z.string()).describe('The table types now in the hub.'),
});
export type SchemaChanged = z.infer<typeof SchemaChanged>;

/** `create_table` / `alter_table` args: a table's name and its row type. */
export const TableArgs = z.object({
  table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe('The table\'s name (`invoices`).'),
  type: GinTypeDef.describe('The row type: an `obj` whose fields are the columns. `optional` fields may be empty; an `id` field (or `key`) is the primary key.'),
  database: z.string().min(1).optional().describe('The database instance; the only one when empty.'),
});
export type TableArgs = z.infer<typeof TableArgs>;

/** `change_schema` args: `create_table` / `alter_table`'s, with what to do and on which instance. */
export const SchemaArgs = TableArgs.extend({ action: z.enum(['create', 'alter']), database: z.string().min(1) });
export type SchemaArgs = z.infer<typeof SchemaArgs>;

/** `apply_type_changes` args: the rescan whose changes an admin approves. */
export const ApplyArgs = z.object({ scan: z.string().min(1).describe('The rescan these changes came from.') });
export type ApplyArgs = z.infer<typeof ApplyArgs>;

/** `pick_database` args: the request, and the database it names, if any. */
export const PickArgs = z.object({
  detailedDescription: z.string().min(1).describe('The request, as get_query was given it.'),
  database: z.string().min(1).optional().describe('The database instance the request names, if any.'),
});
export type PickArgs = z.infer<typeof PickArgs>;

/** How a database was picked: named in the request, the only one, by the decision model, or by its tables' match. */
export const PickedBy = z.enum(['asked', 'only', 'decision', 'score']);
export type PickedBy = z.infer<typeof PickedBy>;

/** The database a request is for, and why. */
export const PickedDatabase = z.object({
  database: z.string().min(1).describe('The database instance to use.'),
  label: z.string(),
  by: PickedBy,
  why: z.string().describe('Why this database, in one sentence.'),
});
export type PickedDatabase = z.infer<typeof PickedDatabase>;

/** What `pick_database` answers: the database, or the question for the person when it stays unclear. */
export const DatabasePick = z.union([PickedDatabase, AskWhichDatabase]);
export type DatabasePick = z.infer<typeof DatabasePick>;

// ─── Generated table fns ─────────────────────────────────────────────────────

/** `table_fns_available` args. */
export const TableFnsArgs = z.object({
  table: z.string().min(1).describe('The table, by name (`projects`) or as its type (`database/main.projects`).'),
  database: z.string().min(1).optional().describe('The database instance; read from the type name, else the only one.'),
});
export type TableFnsArgs = z.infer<typeof TableFnsArgs>;

/** How a listed fn stands in the hub: not made yet, made for this schema, or made for an older one (regenerate it). */
export const TableFnState = z.enum(['new', 'current', 'stale']);
export type TableFnState = z.infer<typeof TableFnState>;

/** One fn a table could have. */
export const TableFnEntry = z.object({
  name: z.string().describe('Its name within the table (`selectPage`, `projectCount`): what `table_fns_generate` takes.'),
  fn: z.string().describe('The fn it is, or would be, in the hub (`database/main.projects_selectPage`).'),
  about: z.string(),
  signature: z.string(),
  mode: z.enum(['read', 'write', 'delete']).describe('Whether it reads, writes (after approval) or deletes rows.'),
  state: TableFnState,
  version: z.number().int().min(1).optional().describe('The saved version, when it exists.'),
});
export type TableFnEntry = z.infer<typeof TableFnEntry>;

/** A table's fns from one place: `crud`, `columns`, `table`, or the relation they come from. */
export const TableFnGroup = z.object({ group: z.string(), fns: z.array(TableFnEntry) });
export type TableFnGroup = z.infer<typeof TableFnGroup>;

/** What `table_fns_available` lists: the table's fns by group, the most useful first, and how many more there are. */
export const TableFnsList = z.object({
  database: DatabaseInfo,
  table: z.string(),
  type: z.string().describe('The type of the table in the hub.'),
  hash: z.string().describe('The schema hash of the table now.'),
  groups: z.array(TableFnGroup),
  more: z.number().int().min(0).describe('Fns left out past the cap.'),
});
export type TableFnsList = z.infer<typeof TableFnsList>;

/** `table_fns_generate` args. */
export const TableFnsGenerateArgs = TableFnsArgs.extend({
  names: z.array(z.string().min(1)).min(1).max(50).describe('The fns to make or bring up to date, by their names in `table_fns_available`.'),
  derived: z.array(z.string().min(1)).optional().describe('Derived fields `selectPage` also shows, sorts and filters on (`projectCount`).'),
});
export type TableFnsGenerateArgs = z.infer<typeof TableFnsGenerateArgs>;

/** One fn `table_fns_generate` made: its name, signature and version, and what happened to it. */
export const GeneratedTableFn = z.object({
  fn: z.string(),
  signature: z.string(),
  version: z.number().int().min(1),
  status: z.enum(['created', 'updated', 'unchanged']),
});
export type GeneratedTableFn = z.infer<typeof GeneratedTableFn>;

/** What `table_fns_generate` gives. */
export const TableFnsGenerated = z.object({ database: DatabaseInfo, table: z.string(), fns: z.array(GeneratedTableFn) });
export type TableFnsGenerated = z.infer<typeof TableFnsGenerated>;

/** What one instance is asked to read for a tool another instance answered (`read_at_instance`, declared read). */
export const ReadInstanceOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('tables') }),
  z.object({ op: z.literal('check'), draft: QueryDraft }),
  z.object({ op: z.literal('table-fns'), table: z.string().min(1) }),
]);
export type ReadInstanceOp = z.infer<typeof ReadInstanceOp>;

/** What one instance is asked to do for a tool another instance answered (`at_instance`): the reads and the writes. */
export const InstanceOp = z.discriminatedUnion('op', [
  ...ReadInstanceOp.options,
  z.object({
    op: z.literal('save'), draft: QueryDraft, args: ParamValues.optional(), askedFor: z.string().optional(), replace: z.boolean().optional(),
  }),
  z.object({ op: z.literal('run'), fn: z.string().min(1), args: ParamValues.optional() }),
  z.object({ op: z.literal('table-fns-generate'), table: z.string().min(1), names: z.array(z.string().min(1)).min(1), derived: z.array(z.string().min(1)).optional() }),
]);
export type InstanceOp = z.infer<typeof InstanceOp>;

/** What an instance answers an `InstanceOp` with, by the same `op`. */
export const InstanceAnswer = z.discriminatedUnion('op', [
  z.object({ op: z.literal('tables'), tables: TablesInfo }),
  z.object({ op: z.literal('check'), check: QueryCheck }),
  z.object({ op: z.literal('save'), saved: SavedQueryRef }),
  z.object({ op: z.literal('run'), run: QueryRun }),
  z.object({ op: z.literal('table-fns'), list: TableFnsList }),
  z.object({ op: z.literal('table-fns-generate'), generated: TableFnsGenerated }),
]);
export type InstanceAnswer = z.infer<typeof InstanceAnswer>;

/** `author_query`'s args: the request, and the saved query to change (`edit_query`). */
export const AuthorArgs = z.object({
  request: z.string().min(1).describe('What the query should do, as the caller described it.'),
  edit: z.string().min(1).optional().describe('The saved query fn to change (`database/main.orders_by_status`); absent to find or write one.'),
});
export type AuthorArgs = z.infer<typeof AuthorArgs>;
