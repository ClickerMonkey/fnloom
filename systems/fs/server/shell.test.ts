import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GroupTree, MsysTree, NOT_STARTED, NodeExec, NodeShell, TailBuffer, chooseShell, commandEnv, posixTree, runProcess } from './shell.ts';

const limits = { outputMax: 1_000, progressEvery: 20 };
const node = process.execPath;
const env = commandEnv(process.env, []);

describe('chooseShell', () => {
  it('uses the configured shell, or the system one when asked', () => {
    expect(chooseShell('/bin/zsh', 'linux', () => false)).toEqual({ type: 'posix', path: '/bin/zsh' });
    expect(chooseShell('system', 'win32', () => true)).toEqual({ type: 'system' });
  });
  it('finds Git Bash on Windows and bash elsewhere, falling back to the system shell', () => {
    expect(chooseShell(undefined, 'win32', (p) => p.startsWith('C:/Program Files/Git'))).toEqual({ type: 'posix', path: 'C:/Program Files/Git/bin/bash.exe' });
    expect(chooseShell(undefined, 'linux', (p) => p === '/usr/bin/bash')).toEqual({ type: 'posix', path: '/usr/bin/bash' });
    expect(chooseShell(undefined, 'darwin', () => false)).toEqual({ type: 'system' });
  });
});

describe('TailBuffer', () => {
  it('keeps the end and says how much was cut', () => {
    const buffer = new TailBuffer(5);
    buffer.push('abc');
    expect(buffer.toString()).toBe('abc');
    buffer.push('defgh\n\n');
    expect(buffer.toString()).toBe('[5 earlier characters cut]\nfgh\n\n');
    expect(buffer.lastLine()).toBe('fgh');
  });
});

describe('runProcess', () => {
  it('collects output and the exit code', async () => {
    const run = await runProcess(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { timeout: 10_000 }, limits);
    expect(run).toMatchObject({ exitCode: 3, ended: 'exit' });
    expect(run.stdout.trim()).toBe('out');
    expect(run.stderr.trim()).toBe('err');
  });

  it('stops at its timeout and reports progress on the way', async () => {
    const seen: Array<[number, string]> = [];
    const run = await runProcess(node, ['-e', 'console.log("tick"); setTimeout(() => {}, 20000)'], { timeout: 400, onOutput: (f, line) => { seen.push([f, line]); } }, limits);
    expect(run).toMatchObject({ ended: 'timeout', exitCode: 124 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([f]) => f >= 0 && f < 1)).toBe(true);
    expect(seen.some(([, line]) => line === 'tick')).toBe(true);
  });

  it('stops when its signal aborts, even if aborted already', async () => {
    const controller = new AbortController();
    // abort once the child has said it is running, not after a guessed delay
    const running = runProcess(node, ['-e', 'console.log("up"); setTimeout(() => {}, 60000)'], {
      timeout: 60_000, signal: controller.signal, onOutput: (_, line) => { if (line === 'up') { controller.abort(); } },
    }, limits);
    expect(await running).toMatchObject({ ended: 'cancelled', exitCode: 130 });
    const early = await runProcess(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 60_000, signal: AbortSignal.abort() }, limits);
    expect(early).toMatchObject({ ended: 'cancelled', exitCode: 130 });
  }, 30_000);

  it('reports a program that cannot start', async () => {
    const run = await new NodeExec(limits).exec('definitely-not-a-program-harness', [], { timeout: 5_000 });
    expect(run.exitCode).toBe(NOT_STARTED);
    expect(run.stderr).toMatch(/ENOENT/);
  });
});

describe('NodeShell', () => {
  it('runs a command line in a folder with the system shell', async () => {
    const shell = new NodeShell({ type: 'system' }, limits);
    const run = await shell.run({ command: 'echo hello', cwd: process.cwd(), timeout: 10_000, signal: new AbortController().signal, env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('hello');
  });

  it('runs a command line with a POSIX shell by path', async () => {
    const choice = chooseShell(undefined, process.platform, existsSync);
    if (choice.type !== 'posix') { return; }
    const run = await new NodeShell(choice, limits).run({ command: 'echo "$((2 + 3))"', cwd: process.cwd(), timeout: 10_000, signal: new AbortController().signal, env });
    expect(run.stdout.trim()).toBe('5');
  });

  it('cancels at once, ending programs the shell started too', async () => {
    const choice = chooseShell(undefined, process.platform, existsSync);
    if (choice.type !== 'posix') { return; }
    const controller = new AbortController();
    const shell = new NodeShell(choice, limits);
    const running = shell.run({
      command: 'echo up; sleep 25 && echo slept', cwd: process.cwd(), timeout: 60_000, signal: controller.signal, env,
      onOutput: (_, line) => { if (line === 'up') { controller.abort(); } },
    });
    const started = performance.now();
    const run = await running;
    expect(run).toMatchObject({ ended: 'cancelled', exitCode: 130 });
    expect(run.stdout).not.toContain('slept');
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 30_000);
});

describe('the command environment', () => {
  it('keeps PATH, home, temp and what the admin allows, never the keys fs has', () => {
    const base = { PATH: '/bin', HOME: '/home/a', TEMP: '/tmp', LANG: 'en_US.UTF-8', OPENROUTER_API_KEY: 'sk-or-1', HARNESS_ADMIN_PASSWORD: 'p', NODE_ENV: 'test' };
    expect(commandEnv(base, [])).toEqual({ PATH: '/bin', HOME: '/home/a', TEMP: '/tmp', LANG: 'en_US.UTF-8' });
    expect(commandEnv(base, ['node_env'])).toMatchObject({ NODE_ENV: 'test' });
  });

  it('starts a real bash command without the keys fs has', async () => {
    const choice = chooseShell(undefined, process.platform, existsSync);
    if (choice.type !== 'posix') { return; }
    process.env['OPENROUTER_API_KEY'] = 'sk-or-planted';
    try {
      const run = await new NodeShell(choice, { ...limits, outputMax: 100_000 }).run({ command: 'env', cwd: process.cwd(), timeout: 10_000, signal: new AbortController().signal, env: commandEnv(process.env, []) });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toMatch(/^PATH=/im);
      expect(run.stdout).not.toContain('sk-or-planted');
      expect(run.stdout).not.toContain('OPENROUTER_API_KEY');
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
  });
});

describe('process trees', () => {
  it('marks every process of an MSYS run with its own marker, and uses process groups off Windows', () => {
    const one = posixTree('C:/Program Files/Git/bin/bash.exe', 'win32');
    const two = posixTree('C:/Program Files/Git/bin/bash.exe', 'win32');
    expect(one).toBeInstanceOf(MsysTree);
    expect(one.env?.['HARNESS_FS_RUN']).toMatch(/^[0-9a-f-]{36}$/);
    expect(one.env?.['HARNESS_FS_RUN']).not.toBe(two.env?.['HARNESS_FS_RUN']);
    expect(posixTree('/bin/bash', 'linux')).toBeInstanceOf(GroupTree);
    expect(posixTree('/bin/bash', 'linux').env).toBeUndefined();
  });
});
