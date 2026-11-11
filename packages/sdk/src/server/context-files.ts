/**
 * A system's context folder: markdown files under `context/`, each a YAML header (`ContextFileHeader`: any context
 * metadata, with a stable `key` people never see) between `---` lines, then its content. `readContextFolder` reads and
 * checks the files on their own (the header against the schema, duplicate keys), with the file and line of every
 * problem; `@harness/build` checks the links between them on top. `serve` sends the entries as the system's context,
 * and with `HARNESS_CONTEXT_WATCH` it watches the folder and patches the hub live, keyed by `key`, so a moved or
 * renamed file updates the same record.
 */
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { backoff } from '@ayepi/core/retry';
import { CORE_SCHEMA, load, YAMLException } from 'js-yaml';
import { ContextFileHeader, contextDeclOf, Json, type ContextDecl, type ContextFileProblem, type ContextFileProblemCode } from '@harness/core';
import { canonicalJson } from '../manifest.ts';
import type { SystemPatch } from './table.ts';

/** The folder of a system that holds its context files. */
export const CONTEXT_FOLDER = 'context';

/** The line every header starts and ends with. */
const FENCE = '---';

/** One checked context file. */
export interface ContextFile {
  /** Its path, relative to the folder it was read from, with forward slashes. */
  readonly file: string;
  /** Its whole text, so later checks can point at a line. */
  readonly source: string;
  readonly header: ContextFileHeader;
  /** What it becomes in the manifest: the header, `key` as the name, and the body as the content. */
  readonly decl: ContextDecl;
  /** The 1-based line its body starts on. */
  readonly bodyLine: number;
}

/** A context folder as read: the files that parsed, and every problem, each at a file and line. */
export interface ContextFolder {
  readonly files: readonly ContextFile[];
  readonly problems: readonly ContextFileProblem[];
}

/** A problem at a 1-based line and column of a file. */
export function contextProblem(file: string, line: number, column: number, code: ContextFileProblemCode, message: string): ContextFileProblem {
  return { file, line, column, code, message };
}

/** Where `needle` first appears at or after a 1-based line (the line itself when it doesn't). */
export function positionOf(source: string, needle: string, fromLine = 1): { line: number; column: number } {
  const lines = source.split(/\r?\n/);
  for (let index = Math.max(0, fromLine - 1); index < lines.length; index += 1) {
    const column = lines[index]?.indexOf(needle) ?? -1;
    if (column >= 0) { return { line: index + 1, column: column + 1 }; }
  }
  return { line: fromLine, column: 1 };
}

/** A problem as the build prints it: `context/kinds.md:3:1 broken-link …`. */
export function formatContextProblem(problem: ContextFileProblem): string {
  return `${problem.file}:${problem.line}:${problem.column} ${problem.code} ${problem.message}`;
}

/** The 1-based line of a top-level header key (`fns:`), if the header has it. */
function keyLine(lines: readonly string[], key: string): number | undefined {
  const index = lines.findIndex((line, i) => i > 0 && new RegExp(`^${key}\\s*:`).test(line));
  return index < 0 ? undefined : index + 1;
}

/** Parse one context file. `file` names it in problems. */
export function parseContextFile(file: string, source: string): { file?: ContextFile; problems: ContextFileProblem[] } {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== FENCE) { return { problems: [contextProblem(file, 1, 1, 'header', `starts with a YAML header between ${FENCE} lines`)] }; }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FENCE);
  if (end < 0) { return { problems: [contextProblem(file, 1, 1, 'header', `its header has no closing ${FENCE} line`)] }; }
  let raw: unknown;
  try {
    raw = load(lines.slice(1, end).join('\n'), { schema: CORE_SCHEMA, filename: file });
  } catch (error) {
    if (!(error instanceof YAMLException)) { throw error; }
    return { problems: [contextProblem(file, (error.mark?.line ?? 0) + 2, (error.mark?.column ?? 0) + 1, 'header', `YAML: ${error.reason}`)] };
  }
  const parsed = ContextFileHeader.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => {
        const key = issue.code === 'unrecognized_keys' ? issue.keys[0] : issue.path[0];
        const line = typeof key === 'string' ? keyLine(lines, key) ?? 2 : 2;
        const code: ContextFileProblemCode = key === 'summary' && !/^summary\s*:/m.test(lines.slice(1, end).join('\n')) ? 'missing-summary' : 'header';
        const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
        return contextProblem(file, line, 1, code, `${where}${issue.message}`);
      }),
    };
  }
  const body = lines.slice(end + 1).join('\n').trim();
  return { file: { file, source, header: parsed.data, decl: contextDeclOf(parsed.data, body), bodyLine: end + 2 }, problems: [] };
}

/** Every `.md` file under a folder, as paths relative to it, sorted. A missing folder has none. */
async function markdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return []; }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * Read and check a context folder: each file's header against the schema (a missing summary called out), and that
 * no two files share a key. `label` prefixes file names in problems (default `context`).
 */
export async function readContextFolder(dir: string, label: string = CONTEXT_FOLDER): Promise<ContextFolder> {
  const files: ContextFile[] = [];
  const problems: ContextFileProblem[] = [];
  const seen = new Map<string, string>();
  for (const path of await markdownFiles(dir)) {
    const name = `${label}/${path}`;
    const parsed = parseContextFile(name, await readFile(join(dir, path), 'utf8'));
    problems.push(...parsed.problems);
    if (parsed.file === undefined) { continue; }
    const first = seen.get(parsed.file.header.key);
    if (first !== undefined) {
      const at = positionOf(parsed.file.source, 'key:');
      problems.push(contextProblem(name, at.line, at.column, 'duplicate-key', `key ${parsed.file.header.key} is already used by ${first}`));
      continue;
    }
    seen.set(parsed.file.header.key, name);
    files.push(parsed.file);
  }
  return { files, problems };
}

/** Thrown when a system starts with a context folder that doesn't check. */
export class ContextFolderError extends Error {
  override readonly name = 'ContextFolderError';
  readonly problems: readonly ContextFileProblem[];
  constructor(problems: readonly ContextFileProblem[]) {
    super(`The context folder has problems:\n${problems.map(formatContextProblem).join('\n')}`);
    this.problems = problems;
  }
}

/** The patch that takes the context from `before` to `after`, by key: changed and new entries upserted, gone ones removed. */
export function contextChange(before: ReadonlyMap<string, ContextDecl>, after: ReadonlyMap<string, ContextDecl>): SystemPatch | undefined {
  const upsert = [...after.values()].filter((decl) => {
    const old = before.get(decl.name);
    return old === undefined || canonicalJson(Json.parse(old)) !== canonicalJson(Json.parse(decl));
  });
  const remove = [...before.keys()].filter((key) => !after.has(key));
  if (upsert.length === 0 && remove.length === 0) { return undefined; }
  return { ...(upsert.length === 0 ? {} : { upsert: { context: upsert } }), ...(remove.length === 0 ? {} : { remove: { context: remove } }) };
}

/** What `watchContextFolder` reports. */
export interface ContextWatchEvents {
  /** The folder has problems; nothing was sent until they are fixed. */
  problems(problems: readonly ContextFileProblem[]): void;
  /** A change went to the hub. */
  sent(change: SystemPatch): void;
  /** Reading or sending a change failed; it is tried again. */
  failed(error: unknown): void;
}

/** How `watchContextFolder` waits: for the folder to settle, and between tries when sending fails. */
export interface ContextWatchOptions {
  /** How long the folder must be quiet before it is read. */
  readonly debounce: number;
  /** The first wait before sending a failed change again; it doubles up to `retryMax`. */
  readonly retry: number;
  readonly retryMax: number;
  /** Prefixes file names in problems (default `context`). */
  readonly label?: string;
  readonly events: ContextWatchEvents;
}

/**
 * Watch a context folder (dev) and send each settled change as a runtime patch, by key. `initial` is what the system
 * started with. One rescan runs at a time (a change during one rescans again after it), so patches reach the hub in
 * order; what the hub has only moves on once a patch is sent, and a failed one is tried again with backoff, so no
 * change is lost. Returns a stop function.
 */
export function watchContextFolder(
  dir: string,
  initial: readonly ContextDecl[],
  send: (change: SystemPatch) => Promise<unknown>,
  options: ContextWatchOptions,
): () => void {
  /** What the hub has: it moves on only once a patch was sent. */
  let sent = new Map(initial.map((decl) => [decl.name, decl]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let running = false;
  let again = false;
  let failures = 0;
  let stopped = false;
  const later = (wait: number): void => {
    if (stopped) { return; }
    if (timer !== undefined) { clearTimeout(timer); }
    timer = setTimeout(() => { timer = undefined; void run(); }, wait);
  };
  const rescan = async (): Promise<void> => {
    const folder = await readContextFolder(dir, options.label);
    if (folder.problems.length > 0) {
      options.events.problems(folder.problems);
      return;
    }
    const next = new Map(folder.files.map((file) => [file.decl.name, file.decl]));
    const change = contextChange(sent, next);
    if (change === undefined) { return; }
    await send(change);
    sent = next;
    options.events.sent(change);
  };
  const run = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      await rescan();
      failures = 0;
    } catch (error) {
      failures += 1;
      options.events.failed(error);
      if (!again) { later(backoff(failures, { base: options.retry, max: options.retryMax, jitter: 0 })); }
    } finally {
      running = false;
    }
    if (again) { again = false; later(0); }
  };
  try {
    watcher = watch(dir, { recursive: true }, () => { later(options.debounce); });
  } catch (error) {
    options.events.failed(error);
  }
  return () => {
    stopped = true;
    if (timer !== undefined) { clearTimeout(timer); }
    watcher?.close();
  };
}
