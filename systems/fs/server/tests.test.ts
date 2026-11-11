/**
 * `ProcessSystemTests`: a folder's tests run in a child under Node's permission model (writes only to the folder's
 * `.harness-test` and the temp folder) with a scrubbed environment, its last line read as the report; a folder with no
 * tests gives none, and a child that printed no report refuses the install with its output.
 */
import { join } from 'node:path';
import { SystemTestReport } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { InstallRefused } from './hosting.ts';
import { ProcessSystemTests, type ChildRun, type ChildRunner } from './tests.ts';

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
  });

  it('gives no report for a folder with no tests, and refuses when the child printed none', async () => {
    expect(await new ProcessSystemTests({ ...options, child: fakeChild({ code: 0, stdout: 'null\n', stderr: '' }) }).run('systems/notes', signal)).toBeUndefined();
    const broken = new ProcessSystemTests({ ...options, child: fakeChild({ code: 1, stdout: '', stderr: 'SyntaxError: nope' }) });
    await expect(broken.run('systems/notes', signal)).rejects.toBeInstanceOf(InstallRefused);
    await expect(broken.run('systems/notes', signal)).rejects.toThrow(/SyntaxError: nope/);
  });
});
