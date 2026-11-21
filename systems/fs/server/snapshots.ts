/**
 * Undo snapshots: earlier file contents kept by sha-256 in the system's state folder, so undoing a write, edit or
 * remove works even when the hub's content store isn't reachable from the system (see the report's contract note:
 * `Files` has no way to fetch a `ContentRef` back yet).
 *
 * They are pruned as they are saved, by the limits an admin sets in the fs config (`snapshots`, else
 * `SNAPSHOT_DEFAULTS`): the newest `perFile` copies of each file are kept, and the oldest copies go first once all of
 * them use more than `totalMb`. An undo whose copy was pruned answers `gone`. An index beside the copies says which
 * file each was taken of and when; copies from before the index are counted as taken when they were written.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentRef } from '@harness/core';
import { contentHash } from '@harness/sdk/server';
import { z } from 'zod';
import { SNAPSHOT_DEFAULTS, type SnapshotLimitsValue } from '../shared/index.ts';
import type { Snapshots } from './index.ts';
import { isErrno } from './problem.ts';

/** The index file in the snapshot folder. */
const INDEX = 'index.json';

/** One kept copy: its hash, the file it was taken of (`''` when not known), its size and when it was taken. */
const Kept = z.object({ hash: ContentRef.shape.hash, path: z.string(), size: z.number().int().min(0), at: z.number() });
type Kept = z.infer<typeof Kept>;
const KeptList = z.array(Kept);

/** Bytes in a megabyte, for `totalMb`. */
const MB = 1024 * 1024;

/** The copies left once the limits are applied, oldest first; the newest copy is always kept. */
export function pruned(kept: readonly Kept[], limits: SnapshotLimitsValue): Kept[] {
  const counts = new Map<string, number>();
  const newestFirst = [...kept].reverse().filter((entry) => {
    const seen = counts.get(entry.path) ?? 0;
    counts.set(entry.path, seen + 1);
    return seen < limits.perFile;
  });
  const sizes = new Map<string, number>();
  const out: Kept[] = [];
  let total = 0;
  for (const entry of newestFirst) {
    const extra = sizes.has(entry.hash) ? 0 : entry.size;
    if (out.length > 0 && total + extra > limits.totalMb * MB) { continue; }
    sizes.set(entry.hash, entry.size);
    total += extra;
    out.push(entry);
  }
  return out.reverse();
}

/** Snapshots in a folder, one file per hash. Saving the same bytes twice keeps one copy. */
export class DiskSnapshots implements Snapshots {
  private readonly folder: string;
  private readonly limits: () => SnapshotLimitsValue;
  private readonly now: () => number;
  private kept: Kept[] | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(folder: string, limits: () => SnapshotLimitsValue = () => SNAPSHOT_DEFAULTS, now: () => number = Date.now) {
    this.folder = folder;
    this.limits = limits;
    this.now = now;
  }

  /** Keep a copy of a file's bytes, then prune; saves run one at a time, as each rewrites the index. */
  save(bytes: Uint8Array, mime: string, path = ''): Promise<ContentRef> {
    const work = this.queue.then(() => this.saveNow(bytes, mime, path));
    this.queue = work.catch(() => undefined);
    return work;
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

  private async saveNow(bytes: Uint8Array, mime: string, path: string): Promise<ContentRef> {
    const ref = ContentRef.parse({ hash: contentHash(bytes), size: bytes.byteLength, mime });
    await mkdir(this.folder, { recursive: true });
    // read before the copy is written, so a first save doesn't count its own copy as one from before the index
    const before = await this.index();
    try {
      await writeFile(join(this.folder, ref.hash), bytes, { flag: 'wx' });
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) { throw error; }
    }
    const after = pruned([...before.filter((entry) => !(entry.hash === ref.hash && entry.path === path)), { hash: ref.hash, path, size: ref.size, at: this.now() }], this.limits());
    const left = new Set(after.map((entry) => entry.hash));
    for (const hash of new Set(before.map((entry) => entry.hash))) {
      if (!left.has(hash)) { await rm(join(this.folder, hash), { force: true }); }
    }
    this.kept = after;
    const temp = join(this.folder, `${INDEX}.tmp`);
    await writeFile(temp, JSON.stringify(after));
    await rename(temp, join(this.folder, INDEX));
    return ref;
  }

  /** The kept copies, oldest first: from the index, else the copies in the folder by when they were written. */
  private async index(): Promise<Kept[]> {
    if (this.kept !== undefined) { return this.kept; }
    try {
      this.kept = KeptList.parse(JSON.parse(await readFile(join(this.folder, INDEX), 'utf8')));
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) { throw error; }
      const names = (await readdir(this.folder)).filter((name) => ContentRef.shape.hash.safeParse(name).success);
      const found = await Promise.all(names.map(async (hash) => { const info = await stat(join(this.folder, hash)); return { hash, path: '', size: info.size, at: info.mtimeMs }; }));
      this.kept = found.sort((a, b) => a.at - b.at);
    }
    return this.kept;
  }
}
