/**
 * Searching the roots: paths by glob and file contents by regular expression. Both scan the same walk, and both
 * read a glob the same way: relative to where the search starts, and a pattern without `/` matches names at any depth.
 */
import { matchesGlob } from 'node:path';
import type { FileService } from './files.ts';
import type { Located, PathGuard } from './index.ts';
import { FsProblem } from './problem.ts';
import { walk, type WalkEntry } from './walk.ts';

/** How far searches go. */
export interface SearchLimits {
  /** Most files one search looks at. */
  readonly scanMax: number;
  /** Characters of a matching line returned. */
  readonly lineMax: number;
  readonly ignore: readonly string[];
}

/** One matching line. */
export interface GrepMatch {
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  readonly text: string;
}

/** Where a search starts: the folder given (a path, or a root's name), else every root. */
export function searchBases(guard: PathGuard, root: string | undefined): Located[] {
  if (root === undefined) {
    if (guard.roots.length === 0) { throw new FsProblem('no-roots', 'No folders are configured yet. An admin sets them in the fs system config.'); }
    return guard.roots.map((r) => ({ path: r.folder, root: r, relative: '' }));
  }
  const named = guard.root(root);
  return [named === undefined ? guard.resolve(root, { write: false }) : { path: named.folder, root: named, relative: '' }];
}

/** A test for walk entries: the glob against the path from the search's start, or against the name when it has no `/`. */
export function globMatcher(pattern: string): (entry: WalkEntry) => boolean {
  const byName = !pattern.includes('/');
  return (entry) => matchesGlob(byName ? entry.name : entry.relative, pattern);
}

/** Compile a search pattern, refusing an invalid one with a message the caller can act on. */
export function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new FsProblem('bad-pattern', `${pattern} isn't a valid regular expression: ${error instanceof Error ? error.message : 'unknown problem'}.`);
  }
}

/** The files (not folders or links) under the bases, up to the scan limit. */
async function* filesUnder(bases: readonly Located[], limits: SearchLimits, signal: AbortSignal): AsyncGenerator<WalkEntry> {
  let seen = 0;
  for (const base of bases) {
    for await (const entry of walk(base.path, { ignore: limits.ignore, signal })) {
      if (entry.type !== 'file') { continue; }
      if (seen >= limits.scanMax) { return; }
      seen += 1;
      yield entry;
    }
  }
}

/** Absolute paths of the files matching a glob. */
export async function globPaths(bases: readonly Located[], pattern: string, limit: number, limits: SearchLimits, signal: AbortSignal): Promise<string[]> {
  const matches = globMatcher(pattern);
  const out: string[] = [];
  for await (const entry of filesUnder(bases, limits, signal)) {
    if (!matches(entry)) { continue; }
    out.push(entry.path);
    if (out.length >= limit) { break; }
  }
  return out;
}

/** Lines matching a pattern in the text files under the bases, reporting how far through the files it is. */
export async function grepFiles(
  files: FileService, bases: readonly Located[],
  query: { pattern: RegExp; glob: string | undefined; limit: number },
  limits: SearchLimits, signal: AbortSignal, onProgress: (fraction: number, message: string) => void,
): Promise<GrepMatch[]> {
  const matches = query.glob === undefined ? () => true : globMatcher(query.glob);
  const candidates: WalkEntry[] = [];
  for await (const entry of filesUnder(bases, limits, signal)) { if (matches(entry)) { candidates.push(entry); } }
  const out: GrepMatch[] = [];
  const every = Math.max(1, Math.floor(candidates.length / 50));
  for (const [i, entry] of candidates.entries()) {
    signal.throwIfAborted();
    if (i % every === 0) { onProgress(i / candidates.length, `${out.length} matches, searching ${entry.relative}`); }
    let text: string;
    try {
      text = await files.text(entry);
    } catch (error) {
      // binary and oversized files are skipped, not errors
      if (error instanceof FsProblem) { continue; }
      throw error;
    }
    for (const [n, line] of text.split('\n').entries()) {
      if (!query.pattern.test(line)) { continue; }
      out.push({ path: entry.path, line: n + 1, text: line.replace(/\r$/, '').slice(0, limits.lineMax) });
      if (out.length >= query.limit) { onProgress(1, `${out.length} matches`); return out; }
    }
  }
  onProgress(1, `${out.length} matches in ${candidates.length} files`);
  return out;
}
