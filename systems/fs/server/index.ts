/**
 * The fs system's server: implements the `fs` contract (files, shell, resources, mentions, git hook, restart) and
 * connects with `serve`. Owner: the fs lane. The implementation is split by concern behind these interfaces so each
 * part is tested with injected seams (a temp folder, a fake shell, a fake clock).
 */
import type { Infer } from '@harness/sdk';
import type { CommandResult, Root } from '../shared/index.ts';

/** A configured root, resolved to an absolute folder. */
export type FsRoot = Infer<typeof Root>;

/** Turns paths given to fns into absolute paths inside a root, refusing anything outside every root. */
export interface PathGuard {
  /** The absolute path and its root, or a problem the LLM can act on. */
  resolve(path: string, options: { write: boolean; cwd?: string }): { ok: true; path: string; root: FsRoot } | { ok: false; problem: string };
}

/** Runs shell commands. An interface so tests use a fake. */
export interface Shell {
  run(input: { command: string; cwd: string; timeout: number; signal: AbortSignal; onOutput?: (fraction: number) => void }): Promise<Infer<typeof CommandResult>>;
}

export { fs } from '../shared/index.ts';
