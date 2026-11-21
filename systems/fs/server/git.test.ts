import { execFileSync } from 'node:child_process';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliGit, describeStatus, gitArgs, gitEnv, hardenedGitConfigEnv, parseStatus } from './git.ts';
import type { CommandRun, Exec } from './index.ts';
import { PlatformOpener, revealCommand } from './reveal.ts';
import { NodeExec } from './shell.ts';
import { tempFolder } from './testing.ts';

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
    expect(exec.calls[0]).toEqual({ file: 'git', args: gitArgs('/srv/work', ['status', '--porcelain=v1', '--branch']) });
    expect(await new CliGit(new TableExec({ exitCode: 128, stdout: '', stderr: 'not a git repository', ended: 'exit' }), 100).status('/x')).toBeUndefined();
    expect(await new CliGit(new TableExec({ ...ok('## main'), ended: 'timeout' }), 100).status('/x')).toBeUndefined();
  });
});

describe('fs\'s own git', () => {
  it('ignores an fsmonitor and hooks a write planted in .git', async () => {
    const tmp = await tempFolder();
    try {
      const repo = tmp.path;
      execFileSync('git', ['init', '-q', repo]);
      await writeFile(`${repo}/a.txt`, 'a\n');
      // the planted program leaves a file behind when git runs it
      await writeFile(`${repo}/mon.sh`, '#!/bin/sh\necho ran > "$(dirname "$0")/planted"\n');
      await chmod(`${repo}/mon.sh`, 0o755);
      execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `${repo}/mon.sh`]);
      await writeFile(`${repo}/.git/hooks/post-index-change`, '#!/bin/sh\necho ran > planted\n');
      await chmod(`${repo}/.git/hooks/post-index-change`, 0o755);
      // plain git runs it: the plant works here
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { stdio: 'ignore' });
      expect(existsSync(`${repo}/planted`)).toBe(true);
      await rm(`${repo}/planted`);
      const status = await new CliGit(new NodeExec({ outputMax: 10_000, progressEvery: 1_000 }), 10_000).status(repo);
      expect(status?.changes).toContain('?? a.txt');
      expect(existsSync(`${repo}/planted`)).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });

  // the environment form needs git 2.31 or later; an older git ignores it
  const version = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })) ?? [];
  const envConfig = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 31);
  it.runIf(envConfig)('keeps a planted fsmonitor from running in the git a safe command line runs', async () => {
    const tmp = await tempFolder();
    try {
      const repo = tmp.path;
      execFileSync('git', ['init', '-q', repo]);
      await writeFile(`${repo}/a.txt`, 'a\n');
      await writeFile(`${repo}/mon.sh`, '#!/bin/sh\necho ran > "$(dirname "$0")/planted"\n');
      await chmod(`${repo}/mon.sh`, 0o755);
      execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', `${repo}/mon.sh`]);
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { stdio: 'ignore' });
      expect(existsSync(`${repo}/planted`)).toBe(true);
      await rm(`${repo}/planted`);
      // as typed, with no -c: only the environment hardens it
      execFileSync('git', ['-C', repo, 'status', '--porcelain'], { stdio: 'ignore', env: { ...process.env, ...hardenedGitConfigEnv() } });
      expect(existsSync(`${repo}/planted`)).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });

  it('runs with no system config and none of fs\'s keys', () => {
    const env = gitEnv({ PATH: '/bin', OPENROUTER_API_KEY: 'sk-or-secret', HARNESS_ADMIN_PASSWORD: 'x' });
    expect(env).toMatchObject({ PATH: '/bin', GIT_CONFIG_NOSYSTEM: '1' });
    expect(env).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(env).not.toHaveProperty('HARNESS_ADMIN_PASSWORD');
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
