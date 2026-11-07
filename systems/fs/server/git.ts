/** Git: the branch and changed files of a root, for the git hook. One `git status` call per root. */
import type { Exec, Git, GitStatus } from './index.ts';

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

/** Git through its command line. */
export class CliGit implements Git {
  private readonly exec: Exec;
  private readonly timeout: number;
  constructor(exec: Exec, timeout: number) {
    this.exec = exec;
    this.timeout = timeout;
  }

  async status(folder: string, signal?: AbortSignal): Promise<GitStatus | undefined> {
    const run = await this.exec.exec('git', ['-C', folder, 'status', '--porcelain=v1', '--branch'], { timeout: this.timeout, ...(signal === undefined ? {} : { signal }) });
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
