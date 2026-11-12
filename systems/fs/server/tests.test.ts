/**
 * `ProcessSystemTests`: a folder's tests run in a child under Node's permission model (writes only to the folder's
 * `.harness-test` and the temp folder) with a scrubbed environment, its last line read as the report; a folder with no
 * tests gives none, and a child that printed no report refuses the install with its output. One run is real: the test
 * files run with no child processes, workers, addons or network.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SystemTestReport } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { InstallRefused } from './hosting.ts';
import { tsxLoader } from './loader.ts';
import { NETWORK_OFF } from './network-guard.ts';
import { ProcessSystemTests, readRoots, type ChildRun, type ChildRunner } from './tests.ts';

const REPORT = SystemTestReport.parse({ system: 'notes', version: '0.1.0', ranAt: 1_000, duration: 20, passed: 1, failed: 0, skipped: 0, cases: [{ file: 'server/link.test.ts', name: 'works', status: 'passed', duration: 3 }] });

/** A child that answers with `ran`, recording how it was started. */
function fakeChild(ran: ChildRun): ChildRunner & { calls: Array<{ args: readonly string[]; env: Record<string, string> }> } {
  const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
  return { calls, run: (_file, args, options) => { calls.push({ args, env: options.env }); return Promise.resolve(ran); } };
}

describe('the install tests in a sandboxed child', () => {
  const signal = new AbortController().signal;
  const options = { nodeArgs: ['--import', 'tsx'], baseEnv: { PATH: '/bin', OPENROUTER_API_KEY: 'secret' }, timeout: 60_000, tempDir: '/tmp' };

  it('runs sandboxed with a scrubbed environment and reads the report from the last line', async () => {
    const child = fakeChild({ code: 0, stdout: `vitest says hi\n${JSON.stringify(REPORT)}\n`, stderr: '' });
    const tests = new ProcessSystemTests({ ...options, child });
    expect(await tests.run('systems/notes', signal)).toEqual(REPORT);
    const [call] = child.calls;
    expect(call?.args).toEqual(expect.arrayContaining(['--permission', `--allow-fs-write=${join('systems/notes', '.harness-test')}`, '--allow-fs-write=/tmp', '--import', 'tsx', 'systems/notes']));
    expect(call?.args.filter((arg) => arg.startsWith('--allow-fs-write'))).toHaveLength(2);
    expect(call?.env).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(call?.args).not.toContain('--allow-fs-read=*');
    expect(call?.args).toContain('--allow-fs-read=systems/notes');
    // the runner (vitest itself) may start processes; the test files' processes get the file grants and the guard only
    expect(call?.args).toContain('--allow-child-process');
    const testArgs: unknown = JSON.parse(call?.args.at(-1) ?? '[]');
    expect(testArgs).toEqual(expect.arrayContaining(['--permission', '--import', expect.stringMatching(/network-guard\.ts$/)]));
    expect(testArgs).not.toEqual(expect.arrayContaining([expect.stringMatching(/^--allow-(child-process|worker|addons)$/)]));
  });

  it('runs real test files with no child processes, workers, addons or network', { timeout: 120_000 }, async () => {
    const dir = resolve(import.meta.dirname, '../../../.harness-test/fs-sandbox');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'system.json'), JSON.stringify({ format: 1, name: 'notes', version: '0.1.0', description: 'Notes.', protocol: 1, server: { entry: 'server/main.ts', external: {} }, instances: 'one' }));
    writeFileSync(join(dir, 'server', 'escape.test.ts'), [
      "import { execFileSync } from 'node:child_process';",
      "import { lookup } from 'node:dns/promises';",
      "import { Worker } from 'node:worker_threads';",
      "import { expect, it } from 'vitest';",
      "it('starts no process', () => { expect(() => execFileSync(process.execPath, ['-v'])).toThrow(); });",
      "it('starts no worker', () => { expect(() => new Worker('1', { eval: true })).toThrow(); });",
      `it('fetches nothing', async () => { const error = await fetch('http://127.0.0.1:4721/').then(() => undefined, (e) => e); expect(String(error?.cause)).toContain(${JSON.stringify(NETWORK_OFF)}); });`,
      `it('connects nowhere', async () => { const net = await import('node:net'); expect(() => net.connect(9, '127.0.0.1')).toThrow(${JSON.stringify(NETWORK_OFF)}); });`,
      `it('looks up no names', () => { expect(() => lookup('example.com')).toThrow(${JSON.stringify(NETWORK_OFF)}); });`,
      "it('reads no keys', () => { expect(process.env.OPENROUTER_API_KEY).toBeUndefined(); });",
    ].join('\n'));
    try {
      const tests = new ProcessSystemTests({ nodeArgs: tsxLoader(import.meta.url).nodeArgs, baseEnv: { ...process.env, OPENROUTER_API_KEY: 'secret' }, timeout: 100_000 });
      const report = await tests.run(dir, signal);
      expect(report?.cases.filter((c) => c.status !== 'passed')).toEqual([]);
      expect(report?.passed).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the tests read the install code and linked library repos, never their data folders', () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'harness-roots-')));
    try {
      const root = join(top, 'harness');
      const lib = join(top, 'aits');
      for (const dir of [join(root, 'node_modules', '@aeye'), join(root, 'packages'), join(root, 'systems'), join(root, '.harness'), join(lib, 'packages', 'ai'), join(lib, 'node_modules'), join(lib, '.secrets')]) { mkdirSync(dir, { recursive: true }); }
      writeFileSync(join(root, 'package.json'), '{}');
      symlinkSync(join(lib, 'packages', 'ai'), join(root, 'node_modules', '@aeye', 'ai'), 'junction');
      expect(readRoots(root)).toEqual([join(lib, 'node_modules'), join(lib, 'packages'), join(root, 'node_modules'), join(root, 'package.json'), join(root, 'packages'), join(root, 'systems')].sort());
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  it('gives no report for a folder with no tests, and refuses when the child printed none', async () => {
    expect(await new ProcessSystemTests({ ...options, child: fakeChild({ code: 0, stdout: 'null\n', stderr: '' }) }).run('systems/notes', signal)).toBeUndefined();
    const broken = new ProcessSystemTests({ ...options, child: fakeChild({ code: 1, stdout: '', stderr: 'SyntaxError: nope' }) });
    await expect(broken.run('systems/notes', signal)).rejects.toBeInstanceOf(InstallRefused);
    await expect(broken.run('systems/notes', signal)).rejects.toThrow(/SyntaxError: nope/);
  });
});
