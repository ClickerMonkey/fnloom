/**
 * The fs system's server: implements the `fs` contract (files, shell, resources, mentions, git hook, restart) and
 * connects with `serve`. The implementation is split by concern behind these interfaces, so each part is tested with
 * injected seams (a temp folder, a fake shell, a fake clock) and `createFsImpl` wires the real ones together.
 */
import type { ContentRef, ResourceLink } from '@harness/core';
import type { ConfigOf, Infer } from '@harness/sdk';
import type { CommandOutput, EntryValue, FsContract, Root } from '../shared/index.ts';

export type { CommandOutput, EntryValue };

/** The fs system's config, as every context receives it. */
export type FsConfig = ConfigOf<FsContract['defs']>;
/** A configured root, as an admin wrote it. */
export type FsRoot = Infer<typeof Root>;
/** What an entry is. */
export type EntryType = EntryValue['type'];

/** A root with its folder made absolute and normalized (forward slashes, no trailing slash). */
export interface ResolvedRoot extends FsRoot {
  readonly folder: string;
}

/** A path inside a root. */
export interface Located {
  /** Absolute and normalized, with forward slashes. */
  readonly path: string;
  readonly root: ResolvedRoot;
  /** The path inside the root with forward slashes; `''` for the root itself. */
  readonly relative: string;
}

/** Turns paths given to fns into absolute paths inside a root, refusing anything outside every root. */
export interface PathGuard {
  readonly roots: readonly ResolvedRoot[];
  /** The root with this name. */
  root(name: string): ResolvedRoot | undefined;
  /**
   * Resolve a path a fn was given: absolute, relative to `cwd` when given, relative to a root named by its first
   * segment, or else relative to the first root. Throws `FsProblem` (`outside`, `read-only`, `no-roots`).
   */
  resolve(path: string, options: { write: boolean; cwd?: string | undefined }): Located;
  /** Which root holds an absolute path, if any. */
  locate(path: string): Located | undefined;
}

/** How a command ended: on its own, by its timeout, or by the run being cancelled. */
export type CommandEnd = 'exit' | 'timeout' | 'cancelled';

/** A finished command: its output and how it ended. */
export interface CommandRun extends CommandOutput {
  readonly ended: CommandEnd;
}

/** What a shell reports while a command runs: how far through its timeout it is, and the last line it printed. */
export type CommandProgress = (fraction: number, line: string) => void;

/** Runs shell command lines. An interface so tests use a fake. */
export interface Shell {
  run(input: { command: string; cwd: string; timeout: number; signal: AbortSignal; onOutput?: CommandProgress }): Promise<CommandRun>;
}

/** Runs one program with arguments, no shell (git, the file manager). An interface so tests use a fake. */
export interface Exec {
  exec(file: string, args: readonly string[], options: { cwd?: string; timeout: number; signal?: AbortSignal }): Promise<CommandRun>;
}

/** Keeps earlier file contents by hash so a change can be undone. */
export interface Snapshots {
  save(bytes: Uint8Array, mime: string): Promise<ContentRef>;
  /** The bytes, or `undefined` when they are no longer kept. */
  load(ref: ContentRef): Promise<Uint8Array | undefined>;
}

/** Shows a file or folder in the computer's file manager. */
export interface Opener {
  reveal(path: string, type: EntryType): Promise<boolean>;
}

/** A file read as text, with the links found in it. */
export interface Document {
  /** The format sectioners and viewers match on: `markdown`, `typescript`, `json`. */
  readonly format: string | undefined;
  readonly text: string;
  readonly links: readonly ResourceLink[];
}

/** Reads files of many formats as text and finds their links (built on `@aeye/resources`). */
export interface Documents {
  /** The format of a path, from its name alone. */
  format(path: string): string | undefined;
  read(path: string, signal?: AbortSignal): Promise<Document>;
}

/** The branch and changed files of a git work tree. */
export interface GitStatus {
  readonly branch: string;
  /** `ahead 1, behind 2`, when tracking a remote. */
  readonly tracking: string | undefined;
  /** Porcelain status lines: `M src/a.ts`, `?? notes.md`. */
  readonly changes: readonly string[];
}

/** Asks git about a folder. */
export interface Git {
  /** The status, or `undefined` when the folder isn't in a git work tree. */
  status(folder: string, signal?: AbortSignal): Promise<GitStatus | undefined>;
}

/** Restarts the process shortly after the current run has answered. */
export interface Restarter {
  schedule(reason: string): void;
}

/** Calls `listener` for every change under `folder` until the returned function is called. */
export type WatchFolder = (folder: string, listener: (event: 'rename' | 'change', file: string) => void) => () => void;

export { fs } from '../shared/index.ts';
