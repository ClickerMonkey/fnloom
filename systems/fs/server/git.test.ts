import { describe, expect, it } from 'vitest';
import { CliGit, describeStatus, parseStatus } from './git.ts';
import type { CommandRun, Exec } from './index.ts';
import { PlatformOpener, revealCommand } from './reveal.ts';

class TableExec implements Exec {
  readonly calls: Array<{ file: string; args: readonly string[] }> = [];
  private readonly answer: CommandRun;
  constructor(answer: CommandRun) {
    this.answer = answer;
  }

  exec(file: string, args: readonly string[]): Promise<CommandRun> {
    this.calls.push({ file, args });
    return Promise.resolve(this.answer);
  }
}

const ok = (stdout: string): CommandRun => ({ exitCode: 0, stdout, stderr: '', ended: 'exit' });

describe('git status', () => {
  it('reads the branch, its tracking and the changes', () => {
    expect(parseStatus('## main...origin/main [ahead 1, behind 2]\n M src/a.ts\n?? notes.md\n')).toEqual({
      branch: 'main', tracking: 'ahead 1, behind 2', changes: ['M src/a.ts', '?? notes.md'],
    });
    expect(parseStatus('## feature\n')).toEqual({ branch: 'feature', tracking: undefined, changes: [] });
    expect(parseStatus('## No commits yet on main\nA  x\n').branch).toBe('main');
  });

  it('describes a root for the LLM, naming up to a limit of files', () => {
    const status = { branch: 'main', tracking: 'ahead 1', changes: ['M a', 'M b', 'M c'] };
    expect(describeStatus('work', status, 2)).toBe('"work": branch main (ahead 1), 3 changed: M a, M b, and 1 more.');
    expect(describeStatus('work', { branch: 'main', tracking: undefined, changes: [] }, 5)).toBe('"work": branch main, no changes.');
  });

  it('asks git once per folder and treats a failure as "not a repository"', async () => {
    const exec = new TableExec(ok('## main\n'));
    expect(await new CliGit(exec, 100).status('/srv/work')).toEqual({ branch: 'main', tracking: undefined, changes: [] });
    expect(exec.calls[0]).toEqual({ file: 'git', args: ['-C', '/srv/work', 'status', '--porcelain=v1', '--branch'] });
    expect(await new CliGit(new TableExec({ exitCode: 128, stdout: '', stderr: 'not a git repository', ended: 'exit' }), 100).status('/x')).toBeUndefined();
    expect(await new CliGit(new TableExec({ ...ok('## main'), ended: 'timeout' }), 100).status('/x')).toBeUndefined();
  });
});

describe('reveal', () => {
  it('uses each platform\'s file manager', () => {
    expect(revealCommand('win32', 'C:/w/a.ts', 'file')).toEqual({ file: 'explorer.exe', args: ['/select,C:\\w\\a.ts'] });
    expect(revealCommand('win32', 'C:/w', 'folder')).toEqual({ file: 'explorer.exe', args: ['C:\\w'] });
    expect(revealCommand('darwin', '/w/a.ts', 'file')).toEqual({ file: 'open', args: ['-R', '/w/a.ts'] });
    expect(revealCommand('linux', '/w/a.ts', 'file')).toEqual({ file: 'xdg-open', args: ['/w'] });
    expect(revealCommand('linux', '/w', 'folder')).toEqual({ file: 'xdg-open', args: ['/w'] });
  });

  it('counts Explorer\'s exit code 1 as shown, but not a launcher that failed', async () => {
    expect(await new PlatformOpener(new TableExec({ ...ok(''), exitCode: 1 }), 'win32', 100).reveal('C:/a', 'file')).toBe(true);
    expect(await new PlatformOpener(new TableExec({ ...ok(''), exitCode: 127 }), 'win32', 100).reveal('C:/a', 'file')).toBe(false);
    expect(await new PlatformOpener(new TableExec({ ...ok(''), exitCode: 1 }), 'linux', 100).reveal('/a', 'file')).toBe(false);
  });
});
