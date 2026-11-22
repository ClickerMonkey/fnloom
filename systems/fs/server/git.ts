/**
 * Git: the branch and changed files of a root, for the git hook (one `git status` call per root), and the hardened
 * way every git fs runs itself is started (`runGit`): a repository's own config can name programs git runs (an
 * fsmonitor, hooks, a pager, an external diff), and a write to `.git/config` must never turn into code fs runs.
 */
import type { CommandRun, Exec, Git, GitStatus } from './index.ts';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { commandEnv } from './shell.ts';

/** Where fs's own git looks for hooks: a path that is never a folder, so no planted hook runs. */
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * The config every git fs runs itself starts with, over whatever the repository says: no fsmonitor, no hooks, no
 * pager, no external diff.
 */
export const HARDENED_GIT_CONFIG: readonly string[] = ['core.fsmonitor=', `core.hooksPath=${NO_HOOKS}`, 'core.pager=cat', 'diff.external='];

/**
 * The hardened config in git's environment form (`GIT_CONFIG_COUNT`, git 2.31 and later), for the git a safe command
 * line runs (`git status`, `git diff`): fs can't add `-c` to what was typed, and those run without asking.
 */
export function hardenedGitConfigEnv(): Record<string, string> {
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(HARDENED_GIT_CONFIG.length) };
  for (const [i, setting] of HARDENED_GIT_CONFIG.entries()) {
    const cut = setting.indexOf('=');
    out[`GIT_CONFIG_KEY_${i}`] = setting.slice(0, cut);
    out[`GIT_CONFIG_VALUE_${i}`] = setting.slice(cut + 1);
  }
  return out;
}

/** The arguments of a hardened git call in a folder, with paths written as they are. */
export function gitArgs(folder: string, args: readonly string[]): string[] {
  return ['-C', folder, ...[...HARDENED_GIT_CONFIG, 'core.quotepath=off'].flatMap((setting) => ['-c', setting]), ...args];
}

/** The environment fs's own git runs with: the command basics, no system config and never a prompt. */
export function gitEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return { ...commandEnv(base, []), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

/** Run fs's own git, hardened (`gitArgs`, `gitEnv`). Diffs also pass `--no-ext-diff --no-textconv` themselves. */
export function runGit(exec: Exec, folder: string, args: readonly string[], options: { timeout: number; signal?: AbortSignal | undefined }): Promise<CommandRun> {
  return exec.exec('git', gitArgs(folder, args), { timeout: options.timeout, env: gitEnv(process.env), ...(options.signal === undefined ? {} : { signal: options.signal }) });
}

/** Read `git status --porcelain=v1 --branch` output. */
export function parseStatus(output: string): GitStatus {
  const [head = '', ...rest] = output.split(/\r?\n/);
  const changes = rest.filter((line) => line.trim() !== '').map((line) => `${line.slice(0, 2).trim()} ${line.slice(3)}`);
  const header = head.replace(/^## /, '');
  const tracking = /\[(.+)\]$/.exec(header)?.[1];
  const branch = header.startsWith('No commits yet on ')
    ? header.slice('No commits yet on '.length)
    : (header.split('...')[0] ?? header).replace(/ \[.+\]$/, '').trim();
  return { branch, tracking, changes };
}

/** A path as compared: real (links followed) when it exists, resolved, and case-folded where the file system ignores case. */
async function comparable(path: string): Promise<string> {
  const real = await realpath(path).catch(() => resolve(path));
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
}

/** Whether a repository's top level (as git prints it) is the folder or inside it. */
export async function within(top: string, folder: string): Promise<boolean> {
  if (top === '') { return false; }
  const rel = relative(await comparable(folder), await comparable(top));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Git through its command line. */
export class CliGit implements Git {
  private readonly exec: Exec;
  private readonly timeout: number;
  constructor(exec: Exec, timeout: number) {
    this.exec = exec;
    this.timeout = timeout;
  }

  async status(folder: string, signal?: AbortSignal): Promise<GitStatus | undefined> {
    // a folder inside a repository rooted above it is not that repository: its branch and changes are another's
    const top = await runGit(this.exec, folder, ['rev-parse', '--show-toplevel'], { timeout: this.timeout, signal });
    if (top.exitCode !== 0 || top.ended !== 'exit' || !(await within(top.stdout.trim(), folder))) { return undefined; }
    const run = await runGit(this.exec, folder, ['status', '--porcelain=v1', '--branch'], { timeout: this.timeout, signal });
    return run.exitCode === 0 && run.ended === 'exit' ? parseStatus(run.stdout) : undefined;
  }
}

/** One root's status as a line for the LLM. */
export function describeStatus(root: string, status: GitStatus, maxFiles: number): string {
  const tracking = status.tracking === undefined ? '' : ` (${status.tracking})`;
  if (status.changes.length === 0) { return `"${root}": branch ${status.branch}${tracking}, no changes.`; }
  const shown = status.changes.slice(0, maxFiles).join(', ');
  const more = status.changes.length > maxFiles ? `, and ${status.changes.length - maxFiles} more` : '';
  return `"${root}": branch ${status.branch}${tracking}, ${status.changes.length} changed: ${shown}${more}.`;
}
