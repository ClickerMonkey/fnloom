/**
 * Walking folders: one depth-first walk, in a stable order (folders first, then by name), that every listing, glob,
 * grep, tree and `@` search shares. Links are reported but never followed, and ignored folder names are skipped.
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { EntryType } from './index.ts';
import { childPath } from './paths.ts';
import { isErrno } from './problem.ts';

/** One thing a walk found. */
export interface WalkEntry {
  /** Absolute, with forward slashes. */
  readonly path: string;
  /** Relative to the folder the walk started in, with forward slashes. */
  readonly relative: string;
  readonly name: string;
  readonly type: EntryType;
  /** 1 for the start folder's children. */
  readonly depth: number;
}

/** How far and what a walk goes through. */
export interface WalkOptions {
  /** Folder names to skip. */
  readonly ignore: readonly string[];
  /** How many levels below the start folder; default: all of them. */
  readonly depth?: number;
  /** Stop after this many entries. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

function typeOf(dirent: Dirent): EntryType {
  if (dirent.isSymbolicLink()) { return 'link'; }
  return dirent.isDirectory() ? 'folder' : 'file';
}

/** Folders first, then by name, so a tree reads naturally and results are stable. */
function order(a: Dirent, b: Dirent): number {
  const folders = Number(b.isDirectory()) - Number(a.isDirectory());
  return folders !== 0 ? folders : a.name.localeCompare(b.name);
}

async function children(folder: string): Promise<Dirent[]> {
  try {
    return (await readdir(folder, { withFileTypes: true })).sort(order);
  } catch (error) {
    // a folder that vanished or can't be read mid-walk is skipped, not fatal
    if (isErrno(error, 'ENOENT') || isErrno(error, 'EACCES') || isErrno(error, 'EPERM') || isErrno(error, 'ENOTDIR')) { return []; }
    throw error;
  }
}

/** Walk `folder` (absolute, forward slashes), yielding what is under it. */
export async function* walk(folder: string, options: WalkOptions): AsyncGenerator<WalkEntry> {
  const ignored = new Set(options.ignore);
  const maxDepth = options.depth ?? Number.POSITIVE_INFINITY;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let count = 0;
  async function* visit(at: string, prefix: string, depth: number): AsyncGenerator<WalkEntry> {
    for (const dirent of await children(at)) {
      options.signal?.throwIfAborted();
      if (count >= limit) { return; }
      const type = typeOf(dirent);
      if (type === 'folder' && ignored.has(dirent.name)) { continue; }
      const path = childPath(at, dirent.name);
      const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      count += 1;
      yield { path, relative, name: dirent.name, type, depth };
      if (type === 'folder' && depth < maxDepth) { yield* visit(path, relative, depth + 1); }
    }
  }
  yield* visit(folder, '', 1);
}

/** Everything a walk yields, as an array. */
export async function collect(folder: string, options: WalkOptions): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  for await (const entry of walk(folder, options)) { out.push(entry); }
  return out;
}
