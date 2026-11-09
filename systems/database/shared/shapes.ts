/**
 * The database system's shapes, zod first: its config, the query kind's payload, and everything its fns hand the
 * model. The contract (`index.ts`) carries each as gin (`ginAs`), and the server parses with these, so each shape has
 * one source.
 */
import { GinTypeDef, Json, ShareRule } from '@harness/core';
import { ResultBlock, ResultFn } from '@harness/sdk';
import { z } from 'zod';

// ─── Config ──────────────────────────────────────────────────────────────────

/** The kinds of connection: a new SQLite file in the instance's data folder, an existing one, Postgres, SQL Server. */
export const CONNECTION_KINDS = ['sqlite-new', 'sqlite-file', 'postgres', 'sqlserver'] as const;
export const ConnectionKind = z.enum(CONNECTION_KINDS);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

/**
 * The connection as the config form holds it: one object whose `kind` says which other fields count. Kept flat so the
 * form draws it plainly and each secret (`url`, `password`) has one path; `Connection` reads it into its exact shape.
 */
export const ConnectionFields = z.object({
  kind: ConnectionKind.describe('Which database: a new SQLite file, an existing SQLite file, Postgres or SQL Server.'),
  path: z.string().min(1).optional().describe('SQLite: the file. For a new file, a name inside the instance\'s data folder (`shop.db`); for an existing one, its full path.'),
  url: z.string().min(1).optional().describe('Postgres: the connection URL (`postgres://user:password@host:5432/db`). Kept as a secret.'),
  host: z.string().min(1).optional().describe('SQL Server: the host name.'),
  port: z.number().int().min(1).max(65535).optional().describe('SQL Server: the port (1433 when empty).'),
  database: z.string().min(1).optional().describe('SQL Server: the database name.'),
  user: z.string().min(1).optional().describe('SQL Server: the user name.'),
  password: z.string().min(1).optional().describe('SQL Server: the password. Kept as a secret.'),
  encrypt: z.boolean().optional().describe('SQL Server: encrypt the connection (on when empty).'),
});
export type ConnectionFields = z.infer<typeof ConnectionFields>;

/** A connection with exactly the fields its kind needs. */
export const Connection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sqlite-new'), path: z.string().min(1).regex(/^[^/\\:]+$/, 'A new SQLite file is a plain file name inside the data folder.') }),
  z.object({ kind: z.literal('sqlite-file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('postgres'), url: z.string().min(1) }),
  z.object({
    kind: z.literal('sqlserver'), host: z.string().min(1), port: z.number().int().default(1433), database: z.string().min(1),
    user: z.string().min(1), password: z.string().min(1), encrypt: z.boolean().default(true),
  }),
]);
export type Connection = z.infer<typeof Connection>;

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
  connection: ConnectionFields,
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

/** What `get_query` and `edit_query` give: the database, the fn, the query, and its result or where its approval is. */
export const QueryAnswer = z.object({
  database: DatabaseInfo,
  fn: ResultFn.extend({ how: QueryHow, why: z.string() }),
  query: z.object({
    sql: z.string().describe('The SQL it runs, readable.'),
    structured: Json.describe('The `@aeye/query` JSON, for edit_query.'),
    params: z.record(z.string(), Json).describe('The values it ran with.'),
    writes: z.boolean(),
  }),
  result: ResultBlock.optional(),
  write: WriteResult.optional(),
  approval: ApprovalState.optional(),
});
export type QueryAnswer = z.infer<typeof QueryAnswer>;

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
