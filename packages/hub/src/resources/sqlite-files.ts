/**
 * A `FileStore` over a SQLite table, so a hub can keep raw content and forms in its database instead of files
 * (`HARNESS_CONTENT_AT=database`). One row per key in `content_blobs`: the bytes as a BLOB, the size, the media type,
 * the user metadata as JSON text and the time it was written. The table is a file store, not a record table, so it
 * lives outside `HUB_TABLES` and opens its own connection to the hub's database file (WAL lets both connections
 * work at once).
 *
 * This belongs in `@ayepi/sqlite` (`sqliteFiles(db)`, a library ask); it lives here until the library has it.
 */
import Database from 'better-sqlite3';
import { collect, toStream, type FileBody, type FileInfo, type FileObject, type FileStore, type ListOptions, type ListResult, type PutOptions } from '@ayepi/files';
import { z } from 'zod';

/** The table the bytes live in. */
export const CONTENT_BLOBS = 'content_blobs';

/** How many keys a listing returns when the caller doesn't say. */
const LIST_LIMIT = 1000;

/** User metadata as stored: string values by name. */
const Metadata = z.record(z.string(), z.string());

/** A row's columns other than the bytes, as SQLite returns them. */
const InfoRow = z.object({
  key: z.string(),
  size: z.number().int().min(0),
  content_type: z.string().nullable(),
  metadata: z.string().nullable(),
  modified_at: z.number().int(),
});
type InfoRow = z.infer<typeof InfoRow>;

/** A row with its bytes. */
const BlobRow = InfoRow.extend({ body: z.instanceof(Uint8Array) });

/** A key as `fsFiles` accepts it: `/`-separated, with no empty, `.` or `..` segment, so both stores agree. */
function checkKey(key: string): string {
  const parts = key.split('/');
  if (key === '' || parts.some((part) => part === '' || part === '.' || part === '..')) { throw new Error(`invalid file key "${key}"`); }
  return key;
}

/** The info of a stored row. */
function infoOf(row: InfoRow): FileInfo {
  const metadata = row.metadata === null ? undefined : Metadata.parse(JSON.parse(row.metadata));
  return {
    key: row.key, size: row.size, modifiedAt: row.modified_at, etag: `"${row.size}-${row.modified_at}"`,
    ...(row.content_type === null ? {} : { contentType: row.content_type }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** The bytes of any body `put` accepts. */
async function bytesOf(body: FileBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) { return body; }
  if (typeof body === 'string') { return new TextEncoder().encode(body); }
  return collect(toStream(body));
}

/** What a SQLite file store needs. */
export interface SqliteFilesOptions {
  /** The database file (the hub's own, so one file holds everything), or `:memory:` in tests. */
  readonly file: string;
  /** How long a write waits for the hub's connection to let go, in milliseconds. */
  readonly busyTimeout: number;
  readonly clock: () => number;
}

/** A `FileStore` whose objects are rows of one SQLite table. */
export class SqliteFiles implements FileStore {
  readonly #db: Database.Database;
  readonly #clock: () => number;
  readonly #put: Database.Statement<[string, Uint8Array, number, string | null, string | null, number]>;
  readonly #get: Database.Statement<[string]>;
  readonly #head: Database.Statement<[string]>;
  readonly #delete: Database.Statement<[string]>;
  readonly #list: Database.Statement<[{ cursor: string; prefix: string; limit: number }]>;

  constructor(options: SqliteFilesOptions) {
    this.#clock = options.clock;
    this.#db = new Database(options.file);
    this.#db.pragma(`busy_timeout = ${options.busyTimeout}`);
    if (options.file !== ':memory:') { this.#db.pragma('journal_mode = WAL'); }
    this.#db.exec(`create table if not exists ${CONTENT_BLOBS} (
      key text primary key, body blob not null, size integer not null, content_type text, metadata text, modified_at integer not null
    ) without rowid`);
    this.#put = this.#db.prepare(`insert or replace into ${CONTENT_BLOBS} (key, body, size, content_type, metadata, modified_at) values (?, ?, ?, ?, ?, ?)`);
    this.#get = this.#db.prepare(`select key, body, size, content_type, metadata, modified_at from ${CONTENT_BLOBS} where key = ?`);
    this.#head = this.#db.prepare(`select key, size, content_type, metadata, modified_at from ${CONTENT_BLOBS} where key = ?`);
    this.#delete = this.#db.prepare(`delete from ${CONTENT_BLOBS} where key = ?`);
    // after the cursor, keys that start with the prefix, in key order
    this.#list = this.#db.prepare(`select key, size, content_type, metadata, modified_at from ${CONTENT_BLOBS} where key > @cursor and substr(key, 1, length(@prefix)) = @prefix order by key limit @limit`);
  }

  async put(key: string, body: FileBody, opts?: PutOptions): Promise<FileInfo> {
    const bytes = await bytesOf(body);
    const row: InfoRow = {
      key: checkKey(key), size: bytes.length, content_type: opts?.contentType ?? null,
      metadata: opts?.metadata === undefined ? null : JSON.stringify(opts.metadata), modified_at: this.#clock(),
    };
    this.#put.run(row.key, bytes, row.size, row.content_type, row.metadata, row.modified_at);
    return infoOf(row);
  }

  get(key: string): Promise<FileObject | undefined> {
    const found: unknown = this.#get.get(checkKey(key));
    if (found === undefined) { return Promise.resolve(undefined); }
    const row = BlobRow.parse(found);
    const bytes = new Uint8Array(row.body);
    const object: FileObject = {
      info: infoOf(row),
      stream: () => toStream(bytes),
      bytes: () => Promise.resolve(bytes),
      text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    };
    return Promise.resolve(object);
  }

  head(key: string): Promise<FileInfo | undefined> {
    const found: unknown = this.#head.get(checkKey(key));
    return Promise.resolve(found === undefined ? undefined : infoOf(InfoRow.parse(found)));
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.#delete.run(checkKey(key)).changes > 0);
  }

  list(prefix: string, opts?: ListOptions): Promise<ListResult> {
    const limit = Math.max(1, opts?.limit ?? LIST_LIMIT);
    const rows = this.#list.all({ cursor: opts?.cursor ?? '', prefix, limit: limit + 1 }).map((row) => InfoRow.parse(row));
    const files = rows.slice(0, limit).map(infoOf);
    const last = files.at(-1);
    return Promise.resolve(rows.length > limit && last !== undefined ? { files, cursor: last.key } : { files });
  }

  /** Close the connection (the hub's own stays open). */
  close(): void {
    this.#db.close();
  }
}
