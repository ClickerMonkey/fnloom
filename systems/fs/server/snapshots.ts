/**
 * Undo snapshots: earlier file contents kept by sha-256 in the system's state folder, so undoing a write, edit or
 * remove works even when the hub's content store isn't reachable from the system (see the report's contract note:
 * `Files` has no way to fetch a `ContentRef` back yet).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentRef } from '@harness/core';
import { contentHash } from '@harness/sdk/server';
import type { Snapshots } from './index.ts';
import { isErrno } from './problem.ts';

/** Snapshots in a folder, one file per hash. Saving the same bytes twice keeps one copy. */
export class DiskSnapshots implements Snapshots {
  private readonly folder: string;
  constructor(folder: string) {
    this.folder = folder;
  }

  async save(bytes: Uint8Array, mime: string): Promise<ContentRef> {
    const ref = ContentRef.parse({ hash: contentHash(bytes), size: bytes.byteLength, mime });
    await mkdir(this.folder, { recursive: true });
    try {
      await writeFile(join(this.folder, ref.hash), bytes, { flag: 'wx' });
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) { throw error; }
    }
    return ref;
  }

  async load(ref: ContentRef): Promise<Uint8Array | undefined> {
    try {
      // parsed again so a hash can only ever name a file in the snapshot folder
      const bytes = await readFile(join(this.folder, ContentRef.parse(ref).hash));
      return contentHash(bytes) === ref.hash ? bytes : undefined;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) { return undefined; }
      throw error;
    }
  }
}
