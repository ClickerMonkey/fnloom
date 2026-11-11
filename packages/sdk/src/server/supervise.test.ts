import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrashPolicy, NodeStarter, permissionArgs, scrubbedEnv } from './supervise.ts';

const policy = { policy: 'on-failure', backoff: 1_000, maxPerHour: 2 } as const;

describe('scrubbedEnv', () => {
  it('keeps only the OS basics and HARNESS_*, never the parent identity, then adds the command env', () => {
    const env = scrubbedEnv(
      { Path: 'p', SystemRoot: 'r', TEMP: 't', OPENAI_API_KEY: 'secret', HOME: 'h', HARNESS_LOG_LEVEL: 'debug', HARNESS_PAIRING_TOKEN: 'fs-token', HARNESS_HUB: 'ws://fs' },
      { HARNESS_HUB: 'ws://child' },
    );
    expect(env).toEqual({ Path: 'p', SystemRoot: 'r', TEMP: 't', HARNESS_LOG_LEVEL: 'debug', HARNESS_HUB: 'ws://child' });
  });
});

describe('CrashPolicy', () => {
  it('stops, restarts at once, backs off, then gives up after too many crashes in an hour', () => {
    let now = 0;
    const crashes = new CrashPolicy({ maxWait: 1_500, restartCode: 75, clock: () => now });
    expect(crashes.decide('a', policy, { code: 1 }, true)).toEqual({ action: 'stopped' });
    expect(crashes.decide('a', policy, { code: 0 }, false)).toEqual({ action: 'stopped' });
    expect(crashes.decide('a', policy, { code: 75 }, false)).toEqual({ action: 'restart-now' });
    expect(crashes.decide('a', policy, { code: 1 }, false)).toEqual({ action: 'restart', wait: 1_000, crashes: 1 });
    expect(crashes.decide('a', policy, { code: 1 }, false)).toEqual({ action: 'restart', wait: 1_500, crashes: 2 });
    expect(crashes.decide('a', policy, { code: 1 }, false)).toEqual({ action: 'give-up', crashes: 3 });
    now = 3_600_001;
    expect(crashes.decide('a', policy, { code: 1 }, false)).toEqual({ action: 'restart', wait: 1_000, crashes: 1 });
    crashes.forget('a');
    expect(crashes.decide('a', { ...policy, policy: 'always' }, { code: 0 }, false)).toMatchObject({ action: 'restart', crashes: 1 });
  });
});

describe('NodeStarter under the permission model', () => {
  let root = '';
  let bundle = '';
  let data = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-supervise-'));
    bundle = join(root, 'bundle');
    data = join(root, 'data');
    await mkdir(bundle);
    await mkdir(data);
    await writeFile(join(bundle, 'main.cjs'), [
      "const fs = require('node:fs');",
      "const { join } = require('node:path');",
      'const tryIt = (f) => { try { f(); return true; } catch { return false; } };',
      'const report = {',
      "  writeData: tryIt(() => fs.writeFileSync(join(process.env.DATA, 'x.txt'), 'x')),",
      "  writeOutside: tryIt(() => fs.writeFileSync(join(process.env.DATA, '..', 'y.txt'), 'y')),",
      "  child: tryIt(() => require('node:child_process').execFileSync(process.execPath, ['-e', '0'])),",
      '  secret: process.env.OPENAI_API_KEY ?? null,',
      '};',
      'console.log(JSON.stringify(report));',
    ].join('\n'));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  const runChild = async (childProcess: boolean) => {
    const starter = new NodeStarter({
      baseEnv: { ...process.env, OPENAI_API_KEY: 'secret' },
      nodeArgs: permissionArgs({ read: [bundle], write: [data], permissions: { childProcess } }),
      outputTail: 4_096,
    });
    const exit = await starter.launch({ run: process.execPath, args: [join(bundle, 'main.cjs')], cwd: data, env: { DATA: data } }).exited;
    const line = exit.output.split('\n').find((text) => text.startsWith('{'));
    expect(exit.code, exit.output).toBe(0);
    return line;
  };

  it('writes only its folders, has no secrets, and starts children only when declared', async () => {
    expect(JSON.parse(await runChild(false) ?? 'null')).toEqual({ writeData: true, writeOutside: false, child: false, secret: null });
    expect(JSON.parse(await runChild(true) ?? 'null')).toMatchObject({ child: true });
  });
});
