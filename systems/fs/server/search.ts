/**
 * Searching the roots: paths by glob and file contents by regular expression. Both scan the same walk, and both
 * read a glob the same way: relative to where the search starts, and a pattern without `/` matches names at any depth.
 * Grep matches on a worker thread with a deadline, so no pattern can hold fs up.
 */
import { matchesGlob } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileService } from './files.ts';
import type { Located, PathGuard } from './index.ts';
import { FsProblem } from './problem.ts';
import { walk, type WalkEntry } from './walk.ts';

/** Why a signal was aborted, as an error (the run's own reason when it gave one). */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The search was cancelled.');
}

/** How far searches go. */
export interface SearchLimits {
  /** Most files one search looks at. */
  readonly scanMax: number;
  /** Characters of a matching line returned. */
  readonly lineMax: number;
  readonly ignore: readonly string[];
  /** How long one grep may match for, in milliseconds. */
  readonly grepTimeout: number;
  /** Characters of each line a grep tests. */
  readonly testMax: number;
}

/**
 * The matcher a grep runs on a worker thread, so a slow pattern (`(a+)+$`) never holds up fs's event loop: it tests
 * each line of a text (cut to `testMax`) and answers the matching lines, cut to `lineMax`, at most `limit` of them.
 */
const MATCHER = `
const { parentPort, workerData } = require('node:worker_threads');
const pattern = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', (job) => {
  const hits = [];
  const lines = job.text.split('\\n');
  for (let i = 0; i < lines.length && hits.length < job.limit; i += 1) {
    const line = lines[i];
    if (pattern.test(line.length > job.testMax ? line.slice(0, job.testMax) : line)) {
      hits.push([i + 1, line.replace(/\\r$/, '').slice(0, job.lineMax)]);
    }
  }
  parentPort.postMessage(hits);
});
`;

/** One file's matching lines: its 1-based line number and text. */
type Hit = [line: number, text: string];

/**
 * A pattern matched off the event loop with a deadline for the whole search. A file that runs past the deadline
 * stops the worker and fails with `timeout`; a cancel stops it mid-file.
 */
class LineMatcher {
  private readonly worker: Worker;
  private readonly deadline: number;
  private readonly timeout: number;
  private readonly signal: AbortSignal;

  constructor(pattern: RegExp, timeout: number, signal: AbortSignal) {
    this.worker = new Worker(MATCHER, { eval: true, workerData: { source: pattern.source, flags: pattern.flags } });
    this.timeout = timeout;
    this.deadline = performance.now() + timeout;
    this.signal = signal;
  }

  match(job: { text: string; limit: number; lineMax: number; testMax: number }): Promise<Hit[]> {
    return new Promise((done, fail) => {
      const finish = (end: () => void) => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
        this.worker.off('message', onMessage).off('error', onError);
        end();
      };
      const onMessage = (hits: Hit[]) => { finish(() => { done(hits); }); };
      const onError = (error: Error) => { finish(() => { fail(error); }); };
      const onAbort = () => { void this.worker.terminate(); finish(() => { fail(abortReason(this.signal)); }); };
      const timer = setTimeout(() => {
        void this.worker.terminate();
        finish(() => { fail(new FsProblem('timeout', `The search took longer than ${Math.round(this.timeout / 1_000)} s, so it was stopped. Try a simpler pattern or a smaller folder.`)); });
      }, Math.max(0, this.deadline - performance.now()));
      this.worker.on('message', onMessage).on('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted) { onAbort(); return; }
      this.worker.postMessage(job);
    });
  }

  close(): Promise<number> {
    return this.worker.terminate();
  }
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

/** Most patterns a glob's brace lists may stand for: each list multiplies the work of every match. */
const GLOB_EXPANSIONS_MAX = 256;

/**
 * Why a glob is too costly to match, or `undefined` when it is fine. The matcher expands brace lists and ranges into
 * one pattern each (`{1..1000000}`, or `{a,b}` twenty times, is a million) and turns extended groups (`+(…)`, `*(…)`)
 * into regular expressions that can take forever, so either could hold fs up.
 */
export function globProblem(pattern: string): string | undefined {
  if (/[@!+*?]\(/.test(pattern)) { return 'groups like +(…) or *(…) aren\'t supported'; }
  if (/\{[^{}]*\.\.[^{}]*\}/.test(pattern)) { return 'ranges like {1..9} aren\'t supported'; }
  let total = 1;
  const open: number[] = [];
  for (const char of pattern) {
    if (char === '{') { open.push(1); } else if (char === ',' && open.length > 0) { open[open.length - 1] = (open.at(-1) ?? 1) + 1; } else if (char === '}' && open.length > 0) { total *= open.pop() ?? 1; }
  }
  return total > GLOB_EXPANSIONS_MAX ? `its {…} lists stand for more than ${GLOB_EXPANSIONS_MAX} patterns` : undefined;
}

/**
 * A test for walk entries: the glob against the path from the search's start, or against the name when it has no `/`.
 * A glob too costly to match (`globProblem`) is refused.
 */
export function globMatcher(pattern: string): (entry: WalkEntry) => boolean {
  const problem = globProblem(pattern);
  if (problem !== undefined) { throw new FsProblem('bad-pattern', `${pattern} can't be used as a glob: ${problem}.`); }
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
  const matcher = new LineMatcher(query.pattern, limits.grepTimeout, signal);
  try {
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
      const hits = await matcher.match({ text, limit: query.limit - out.length, lineMax: limits.lineMax, testMax: limits.testMax });
      out.push(...hits.map(([line, found]) => ({ path: entry.path, line, text: found })));
      if (out.length >= query.limit) { onProgress(1, `${out.length} matches`); return out; }
    }
  } finally {
    await matcher.close();
  }
  onProgress(1, `${out.length} matches in ${candidates.length} files`);
  return out;
}
