/**
 * Where the hub keeps raw content and forms: files under the data folder (`fsFiles`, the default) or the hub's
 * database (`SqliteFiles`), by `HARNESS_CONTENT_AT`. Everything above it (`FileContentStore`, `mountFiles`, presigned
 * downloads with Range) takes any `FileStore`, so the choice is made here once, at boot, and nothing else changes.
 */
import { fsFiles } from '@ayepi/files/fs';
import type { FileStore } from '@ayepi/files';
import type { ResourcesEnv } from './env.ts';
import { SqliteFiles } from './sqlite-files.ts';

/** What choosing the content store needs. */
export interface ContentFilesOptions {
  readonly at: ResourcesEnv['HARNESS_CONTENT_AT'];
  /** The files folder (`HARNESS_FILES_DIR`). */
  readonly dir: string;
  /** The hub's database file (`HARNESS_DB_FILE`). */
  readonly database: string;
  readonly busyTimeout: number;
  readonly clock: () => number;
  /** Told about an I/O failure of the files store (it is thrown too). */
  readonly onError?: (error: unknown, op: string, key: string) => void;
}

/** The chosen store, and how to let go of it when the hub stops. */
export interface ContentFiles {
  readonly files: FileStore;
  close(): void;
}

/** Open the content store `HARNESS_CONTENT_AT` names. */
export function openContentFiles(options: ContentFilesOptions): ContentFiles {
  switch (options.at) {
    case 'files':
      return { files: fsFiles({ dir: options.dir, ...(options.onError === undefined ? {} : { onError: options.onError }) }), close: () => undefined };
    case 'database': {
      const files = new SqliteFiles({ file: options.database, busyTimeout: options.busyTimeout, clock: options.clock });
      return { files, close: () => { files.close(); } };
    }
  }
}
