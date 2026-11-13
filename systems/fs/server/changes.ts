/**
 * What a `bash` call changed (core `changes.ts`). `CommandChanges.start` runs before the command and `finish` after it:
 *
 * - **Inside git** it takes `git status --porcelain=v2 -z` and `HEAD` before and after. Files already changed before
 *   the call are fingerprinted first (a hash, and a copy of small text ones in a scratch folder), so only what the
 *   call did is counted. A file counts when its status or content moved: one clean before is diffed against the old
 *   `HEAD` (`git diff`), one changed before against its kept copy (`git diff --no-index`), a new one against nothing.
 *   A moved `HEAD` (a checkout, a pull) adds the files it changed. A watcher on the work tree for the call's life
 *   counts the changed files git ignores (build output), which are never listed.
 * - **Outside git** the watcher, started on the call's folder, is all there is: files are listed, not diffed.
 *
 * A change is tied to the call because it was seen between start and finish in the call's tree; when another call
 * (a second `bash`, a `write`) worked in the same tree meanwhile, its files are listed with `certain: false`. Binary,
 * large and sensitive files are listed without a diff, saying why. The list is capped (`truncated`).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileChange, FileChangeStatus, NoDiffReason } from '@harness/core';
import type { GitIgnores, Sensitivity } from './sensitive.ts';
import type { CaptureSession, ChangeCapture, Exec, Located, PathGuard, WatchFolder } from './index.ts';
import { inside, normalize } from './paths.ts';

/** How change capture is bounded. */
export interface ChangeLimits {
  /** Most files a change set lists. */
  readonly maxFiles: number;
  /** Largest file (and diff) shown as a diff, in bytes; larger ones are listed as `large`. */
  readonly diffMaxBytes: number;
  /** Most characters of diff one change set carries in all; files past it are listed as `large`. */
  readonly diffTotalBytes: number;
  /** How long each git command may take. */
  readonly gitTimeout: number;
  /** How long after the command ends the watcher still listens, for events the system reports late. */
  readonly settle: number;
  /** Folder names counted as ignored outside git (`FS_IGNORE`). */
  readonly ignore: readonly string[];
  /** Where copies of files changed before a call are kept until it finishes. */
  readonly scratch: string;
}

/** What change capture is built from. */
export interface ChangeDeps {
  /** Runs git; its output limit must be above `diffMaxBytes`. */
  readonly exec: Exec;
  readonly ignores: Pick<GitIgnores, 'ignoredIn'>;
  readonly watch: WatchFolder;
  readonly limits: ChangeLimits;
  readonly now: () => number;
}

/** One `git status --porcelain=v2` entry. */
export interface StatusEntry {
  readonly kind: 'tracked' | 'renamed' | 'unmerged' | 'untracked';
  /** The two status letters (`.M`, `A.`, `??`). */
  readonly xy: string;
  /** The path a rename came from. */
  readonly from?: string;
}

/** Read `git status --porcelain=v2 -z` output: path (from the work tree, with `/`) to its entry. */
export function parseStatusV2(output: string): Map<string, StatusEntry> {
  const out = new Map<string, StatusEntry>();
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    const type = field[0];
    if (type === '?') { out.set(field.slice(2), { kind: 'untracked', xy: '??' }); continue; }
    if (type !== '1' && type !== '2' && type !== 'u') { continue; }
    // ordinary entries have 8 fields before the path, renames 9 (the score), unmerged 10
    const before = type === '1' ? 8 : type === '2' ? 9 : 10;
    const parts = field.split(' ');
    const path = parts.slice(before).join(' ');
    const xy = parts[1] ?? '..';
    if (type === '2') {
      i += 1;
      out.set(path, { kind: 'renamed', xy, from: fields[i] ?? '' });
    } else {
      out.set(path, { kind: type === 'u' ? 'unmerged' : 'tracked', xy });
    }
  }
  return out;
}

/** A file as it was before the call: a fingerprint, and a copy when it is small text. */
interface Kept {
  /** A content hash, `size:mtime` for a large file, or `missing`. */
  readonly sign: string;
  readonly copy?: string;
  readonly binary: boolean;
  readonly large: boolean;
}

/** What a watcher reported for a path: it came or went (`rename`), or it was written (`change`). */
type WatchEvent = Parameters<Parameters<WatchFolder>[1]>[0];

/** How far file times (a coarse clock, about 16 ms on Windows) may trail `now` for a file written during the call. */
const CLOCK_SLACK_MS = 20;

/** How many bytes are checked for NUL to tell binary from text. */
const SNIFF = 8_000;

/** Whether bytes look binary. */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF).includes(0);
}

/** A call (or another fs call) working in a tree, and whether another one overlapped it. */
interface Busy {
  readonly tree: string;
  overlapped: boolean;
}

/** Whether two folders are one inside the other. */
function overlaps(a: string, b: string): boolean {
  return inside(a, b) !== undefined || inside(b, a) !== undefined;
}

/** Count the lines a unified diff adds and removes (after its first hunk header). */
export function patchStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let body = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { body = true; continue; }
    if (!body) { continue; }
    if (line.startsWith('+')) { added += 1; } else if (line.startsWith('-')) { removed += 1; }
  }
  return { added, removed };
}

/** A diff with git's header replaced by one naming the file from the work tree (a kept copy has a scratch name). */
export function withHeader(raw: string, rel: string, status: FileChangeStatus, from: string | undefined): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const hunk = lines.findIndex((line) => line.startsWith('@@'));
  const body = hunk < 0 ? '' : lines.slice(hunk).join('\n');
  const old = status === 'added' ? '/dev/null' : `a/${from ?? rel}`;
  const now = status === 'deleted' ? '/dev/null' : `b/${rel}`;
  const head = [`diff --git a/${from ?? rel} b/${rel}`, ...(from === undefined ? [] : [`rename from ${from}`, `rename to ${rel}`]), `--- ${old}`, `+++ ${now}`];
  return [...head, ...(body === '' ? [] : [body.replace(/\n$/, '')])].join('\n');
}

/** A change listed without its diff because the change set's diffs are already as long as they may be. */
function withoutDiff(change: FileChange): FileChange {
  const { diff: _diff, added: _added, removed: _removed, ...rest } = change;
  return { ...rest, noDiff: 'large' };
}

/** The real change capture: git where there is a work tree, a watcher elsewhere. */
export class CommandChanges implements ChangeCapture {
  readonly #deps: ChangeDeps;
  readonly #busy = new Set<Busy>();

  constructor(deps: ChangeDeps) {
    this.#deps = deps;
  }

  busy(path: string): () => void {
    const entry = this.#enter(normalize(path));
    return () => { this.#busy.delete(entry); };
  }

  async start(input: { cwd: string; guard: PathGuard; sensitivity: Sensitivity }, signal?: AbortSignal): Promise<CaptureSession> {
    const top = await this.#git(input.cwd, ['rev-parse', '--show-toplevel'], signal);
    if (top.exitCode !== 0 || top.ended !== 'exit' || top.stdout.trim() === '') { return this.#watcherSession(input); }
    return this.#gitSession(normalize(top.stdout.trim()), input, signal);
  }

  /** Register work in a tree, marking it and every overlapping one. */
  #enter(tree: string): Busy {
    const entry: Busy = { tree, overlapped: false };
    for (const other of this.#busy) {
      if (overlaps(other.tree, tree)) { other.overlapped = true; entry.overlapped = true; }
    }
    this.#busy.add(entry);
    return entry;
  }

  /** Run git in a folder with the settings every call here uses. */
  #git(folder: string, args: readonly string[], signal: AbortSignal | undefined) {
    return this.#deps.exec.exec('git', ['-C', folder, '-c', 'core.quotepath=off', ...args], { timeout: this.#deps.limits.gitTimeout, ...(signal === undefined ? {} : { signal }) });
  }

  /**
   * Watch a folder, collecting the paths (relative, with `/`) that changed under it, each with the first event seen
   * for it: `rename` first means the path came into being (or went) during the call, `change` that it was written.
   */
  #watch(folder: string): { readonly seen: Map<string, WatchEvent>; stop(): Promise<void> } {
    const seen = new Map<string, WatchEvent>();
    const stop = this.#deps.watch(folder, (event, file) => {
      const rel = file.replaceAll('\\', '/');
      if (!seen.has(rel)) { seen.set(rel, event); }
    });
    return {
      seen,
      stop: async () => {
        await new Promise((done) => { setTimeout(done, this.#deps.limits.settle); });
        stop();
      },
    };
  }

  async #gitSession(top: string, input: { guard: PathGuard; sensitivity: Sensitivity }, signal: AbortSignal | undefined): Promise<CaptureSession> {
    const limits = this.#deps.limits;
    const headBefore = await this.#head(top, signal);
    const before = parseStatusV2((await this.#git(top, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], signal)).stdout);
    const busy = this.#enter(top);
    const watcher = this.#watch(top);
    let scratch: string | undefined;
    const kept = new Map<string, Kept>();
    try {
      for (const rel of before.keys()) {
        const sign = await this.#sign(join(top, rel), true);
        if (sign.copy !== undefined) {
          if (scratch === undefined) {
            await mkdir(limits.scratch, { recursive: true });
            scratch = await mkdtemp(join(limits.scratch, 'call-'));
          }
          const copy = join(scratch, String(kept.size));
          await writeFile(copy, sign.copy);
          kept.set(rel, { ...sign, copy });
        } else {
          kept.set(rel, { sign: sign.sign, binary: sign.binary, large: sign.large });
        }
      }
    } catch (error) {
      this.#busy.delete(busy);
      await watcher.stop();
      if (scratch !== undefined) { await rm(scratch, { recursive: true, force: true }); }
      throw error;
    }

    return {
      finish: async (finishSignal) => {
        try {
          await watcher.stop();
          const after = parseStatusV2((await this.#git(top, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], finishSignal)).stdout);
          const headAfter = await this.#head(top, finishSignal);
          const moved = headBefore !== undefined && headAfter !== undefined && headBefore !== headAfter ? await this.#movedBy(top, headBefore, headAfter, finishSignal) : new Map<string, FileChangeStatus>();
          const candidates = [...new Set([...kept.keys(), ...after.keys(), ...moved.keys()])].filter((rel) => rel !== '.git' && !rel.startsWith('.git/')).sort();
          const files: FileChange[] = [];
          let truncated = false;
          let budget = limits.diffTotalBytes;
          for (const rel of candidates) {
            const at = input.guard.locate(normalize(join(top, rel)));
            if (at === undefined) { continue; }
            const change = await this.#judgeGit({ top, rel, at, kept: kept.get(rel), after: after.get(rel), moved: moved.get(rel), headBefore, certain: !busy.overlapped, sensitivity: input.sensitivity }, finishSignal);
            if (change === undefined) { continue; }
            if (files.length >= limits.maxFiles) { truncated = true; break; }
            budget -= change.diff?.length ?? 0;
            files.push(budget < 0 && change.diff !== undefined ? withoutDiff(change) : change);
          }
          const listed = new Set(candidates);
          const ignored = await this.#countIgnored(top, [...watcher.seen.keys()].filter((rel) => !listed.has(rel) && rel !== '.git' && !rel.startsWith('.git/')), finishSignal);
          return { source: 'git', cwd: top, files, ignored, truncated };
        } finally {
          this.#busy.delete(busy);
          if (scratch !== undefined) { await rm(scratch, { recursive: true, force: true }); }
        }
      },
    };
  }

  /** The commit `HEAD` names, or `undefined` before the first commit. */
  async #head(top: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const run = await this.#git(top, ['rev-parse', '--verify', '-q', 'HEAD'], signal);
    const head = run.stdout.trim();
    return run.exitCode === 0 && head !== '' ? head : undefined;
  }

  /** The files a moved `HEAD` changed, with how. */
  async #movedBy(top: string, from: string, to: string, signal: AbortSignal | undefined): Promise<Map<string, FileChangeStatus>> {
    const run = await this.#git(top, ['diff', '--no-renames', '--name-status', '-z', from, to], signal);
    const out = new Map<string, FileChangeStatus>();
    const fields = run.stdout.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const letter = fields[i] ?? '';
      const path = fields[i + 1] ?? '';
      if (path === '') { continue; }
      out.set(path, letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified');
    }
    return out;
  }

  /** A file's fingerprint now; with `keep`, the text of a small text file too. */
  async #sign(path: string, keep: boolean): Promise<{ sign: string; binary: boolean; large: boolean; copy?: Uint8Array }> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) { return { sign: 'missing', binary: false, large: false }; }
    if (info.size > this.#deps.limits.diffMaxBytes) { return { sign: `${String(info.size)}:${String(info.mtimeMs)}`, binary: false, large: true }; }
    const bytes = await readFile(path);
    const binary = isBinary(bytes);
    const sign = createHash('sha1').update(bytes).digest('hex');
    return { sign, binary, large: false, ...(keep && !binary ? { copy: bytes } : {}) };
  }

  /** Whether a file the call may have touched changed, and how; `undefined` when it didn't. */
  async #judgeGit(file: {
    top: string; rel: string; at: Located; kept: Kept | undefined; after: StatusEntry | undefined; moved: FileChangeStatus | undefined;
    headBefore: string | undefined; certain: boolean; sensitivity: Sensitivity;
  }, signal: AbortSignal | undefined): Promise<FileChange | undefined> {
    const abs = join(file.top, file.rel);
    const now = await this.#sign(abs, false);
    const exists = now.sign !== 'missing';
    const from = file.after?.from;
    let status: FileChangeStatus;
    if (file.kept !== undefined) {
      if (file.kept.sign === now.sign && from === undefined) { return undefined; }
      status = !exists ? 'deleted' : file.kept.sign === 'missing' ? 'added' : 'modified';
    } else if (from !== undefined) {
      status = 'renamed';
    } else if (file.after !== undefined) {
      status = !exists ? 'deleted' : file.after.kind === 'untracked' || file.after.xy.startsWith('A') || file.headBefore === undefined ? 'added' : 'modified';
    } else {
      // clean before and after: only a moved HEAD (a checkout, a pull) changed it
      status = file.moved ?? 'modified';
    }
    const base = { path: file.at.relative, root: file.at.root.name, status, ...(from === undefined ? {} : { from }), ...(exists ? { size: (await stat(abs)).size } : {}), certain: file.certain };
    // the before side is scanned too: a call that strips a token or deletes a key file would show it on a `-` line
    const rule = await file.sensitivity.changed(file.at, await this.#beforeText(file, signal));
    if (rule !== undefined) { return { ...base, noDiff: 'sensitive', sensitive: rule.kind }; }
    const binary = now.binary || (!exists && file.kept?.binary === true);
    if (binary) { return { ...base, noDiff: 'binary' }; }
    if (now.large || (!exists && file.kept?.large === true)) { return { ...base, noDiff: 'large' }; }
    const raw = await this.#diff(file, abs, exists, status, signal);
    if (raw === undefined) { return file.kept === undefined ? undefined : { ...base, noDiff: file.kept.binary ? 'binary' : 'large' }; }
    if (raw.trim() === '') { return file.kept === undefined && from === undefined ? undefined : { ...base, diff: withHeader('', file.rel, status, from), added: 0, removed: 0 }; }
    if (/^Binary files .* differ$/m.test(raw)) { return { ...base, noDiff: 'binary' }; }
    if (raw.length >= this.#deps.limits.diffMaxBytes) { return { ...base, noDiff: 'large' }; }
    const diff = withHeader(raw, file.rel, status, from);
    return { ...base, diff, ...patchStats(diff) };
  }

  /**
   * The text a file held before the call, for the sensitivity scan: the copy kept of a file dirty before it, else its
   * blob at the `HEAD` the call started on (under its old name for a rename). `undefined` when there is none.
   */
  async #beforeText(file: { top: string; rel: string; kept: Kept | undefined; headBefore: string | undefined; after: StatusEntry | undefined }, signal: AbortSignal | undefined): Promise<string | undefined> {
    if (file.kept !== undefined) {
      return file.kept.copy === undefined ? undefined : readFile(file.kept.copy, 'utf8').catch(() => undefined);
    }
    if (file.headBefore === undefined) { return undefined; }
    const blob = await this.#git(file.top, ['cat-file', 'blob', `${file.headBefore}:${file.after?.from ?? file.rel}`], signal);
    return blob.ended === 'exit' && blob.exitCode === 0 ? blob.stdout : undefined;
  }

  /** The raw diff of a file from before the call to now; `undefined` when there is nothing to diff against. */
  async #diff(file: { top: string; rel: string; kept: Kept | undefined; headBefore: string | undefined; after: StatusEntry | undefined }, abs: string, exists: boolean, status: FileChangeStatus, signal: AbortSignal | undefined): Promise<string | undefined> {
    const flags = ['--no-color', '--no-ext-diff'];
    const nothing = '/dev/null';
    if (file.kept !== undefined) {
      if (file.kept.sign === 'missing') { return (await this.#git(file.top, ['diff', ...flags, '--no-index', '--', nothing, abs], signal)).stdout; }
      if (file.kept.copy === undefined) { return undefined; }
      return (await this.#git(file.top, ['diff', ...flags, '--no-index', '--', file.kept.copy, exists ? abs : nothing], signal)).stdout;
    }
    if (status === 'added' && (file.after?.kind === 'untracked' || file.headBefore === undefined)) {
      return (await this.#git(file.top, ['diff', ...flags, '--no-index', '--', nothing, abs], signal)).stdout;
    }
    if (file.headBefore === undefined) { return undefined; }
    const paths = file.after?.from === undefined ? [file.rel] : [file.after.from, file.rel];
    return (await this.#git(file.top, ['diff', ...flags, '-M', file.headBefore, '--', ...paths], signal)).stdout;
  }

  /**
   * How many of the watcher's paths git ignores. Folders are asked about first, shallowest first, so a whole ignored
   * folder (`node_modules/`, `dist/`) costs one question however many files changed in it.
   */
  async #countIgnored(top: string, seen: readonly string[], signal: AbortSignal | undefined): Promise<number> {
    let pending = seen.filter((rel) => rel !== '');
    let count = 0;
    for (let depth = 1; pending.length > 0; depth += 1) {
      const folders = [...new Set(pending.filter((rel) => rel.split('/').length > depth).map((rel) => `${rel.split('/').slice(0, depth).join('/')}/`))];
      if (folders.length === 0) { break; }
      const ignored = await this.#deps.ignores.ignoredIn(top, folders, signal);
      const under = (rel: string) => [...ignored].some((folder) => rel.startsWith(folder.endsWith('/') ? folder : `${folder}/`));
      count += pending.filter(under).length;
      pending = pending.filter((rel) => !under(rel));
    }
    const files = await this.#deps.ignores.ignoredIn(top, pending, signal);
    return count + files.size;
  }

  async #watcherSession(input: { cwd: string; guard: PathGuard; sensitivity: Sensitivity }): Promise<CaptureSession> {
    const cwd = normalize(input.cwd);
    const started = this.#deps.now();
    const busy = this.#enter(cwd);
    const watcher = this.#watch(cwd);
    return Promise.resolve({
      finish: async () => {
        try {
          await watcher.stop();
          const files: FileChange[] = [];
          let ignored = 0;
          let truncated = false;
          for (const [rel, first] of [...watcher.seen].sort(([a], [b]) => a.localeCompare(b))) {
            if (rel.split('/').some((part) => this.#deps.limits.ignore.includes(part))) { ignored += 1; continue; }
            const at = input.guard.locate(normalize(join(cwd, rel)));
            if (at === undefined) { continue; }
            const change = await this.#judgeWatched(at, first, started, !busy.overlapped, input.sensitivity);
            if (change === undefined) { continue; }
            if (files.length >= this.#deps.limits.maxFiles) { truncated = true; break; }
            files.push(change);
          }
          return { source: 'watcher', cwd, files, ignored, truncated };
        } finally {
          this.#busy.delete(busy);
        }
      },
    });
  }

  /**
   * A file the watcher saw, never diffed: deleted when gone; added when its first event was a rename (created or moved
   * in) or it was born during the call; else modified. File times come from a coarser clock than `now`, so they are
   * compared with `CLOCK_SLACK_MS` to spare.
   */
  async #judgeWatched(at: Located, first: WatchEvent, started: number, certain: boolean, sensitivity: Sensitivity): Promise<FileChange | undefined> {
    const info = await stat(at.path).catch(() => undefined);
    if (info !== undefined && !info.isFile()) { return undefined; }
    const since = started - CLOCK_SLACK_MS;
    const born = info !== undefined && (first === 'rename' || info.birthtimeMs >= since);
    // a file the watcher reported whose content is older than the call was only looked at (or its folder was)
    if (info !== undefined && !born && info.mtimeMs < since) { return undefined; }
    const status: FileChangeStatus = info === undefined ? 'deleted' : born ? 'added' : 'modified';
    const rule = await sensitivity.changed(at);
    const noDiff: NoDiffReason = rule === undefined ? 'not-in-git' : 'sensitive';
    return { path: at.relative, root: at.root.name, status, ...(info === undefined ? {} : { size: info.size }), noDiff, ...(rule === undefined ? {} : { sensitive: rule.kind }), certain };
  }
}

