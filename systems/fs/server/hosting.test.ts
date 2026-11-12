import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InstanceName, SystemName, type InstallSubject, type SystemTestReport } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Hosting, InstallRefused, capped, fnsDiff, type BuiltSystem, type HostedLaunch, type HostedRunner, type RunnerStatus, type StartOutcome, type SystemBuilds, type SystemTests } from './hosting.ts';

const host = { system: SystemName.parse('fs'), instance: InstanceName.parse('main') };
const signal = new AbortController().signal;

/** A system folder in a fresh temp folder. */
function folder(name = 'random', version = '0.1.0'): string {
  mkdirSync('.harness-test', { recursive: true });
  const dir = mkdtempSync(join('.harness-test', 'hosting-'));
  writeFileSync(join(dir, 'system.json'), JSON.stringify({ format: 1, name, version, description: 'Random numbers.', protocol: 1, server: { entry: 'server/main.ts' } }));
  return dir;
}

/** A builder whose answers the test sets: problems, or a bundle with these fns. */
class FakeBuilds implements SystemBuilds {
  problems: string[] = [];
  fns = ['random/random (read)'];
  source = 'source-1';
  builds = 0;

  sourceHash(): Promise<string> {
    return Promise.resolve(this.source);
  }

  /** The fake bundle's text is its hash, so editing the file changes it. */
  bundleHash(file: string): Promise<string> {
    return Promise.resolve(readFileSync(file, 'utf8'));
  }

  build(dir: string, outDir: string): Promise<{ problems: readonly string[] } | { built: BuiltSystem }> {
    this.builds += 1;
    if (this.problems.length > 0) { return Promise.resolve({ problems: this.problems }); }
    mkdirSync(join(outDir, 'server'), { recursive: true });
    writeFileSync(join(outDir, 'server', 'main.js'), `b-${this.source}`);
    const version = dir.length > 0 ? '0.1.0' : '';
    return Promise.resolve({
      built: {
        manifest: { format: 1, name: SystemName.parse('random'), version, description: 'Random numbers.', protocol: 1, server: { entry: 'server/main.js', external: {} }, instances: 'one' },
        manifestHash: `m-${this.fns.join(',')}`, bundleHash: `b-${this.source}`, entry: join(outDir, 'server', 'main.js'),
        fns: this.fns, adds: [], scan: { size: 2048, builtins: [], concerns: [], urls: [], hosts: [] },
        grants: { hub: [], network: ['api.example.com'], files: { read: ['shared'], write: [] } },
      },
    });
  }
}

/** A runner that answers starts as told and remembers what it started. */
class FakeRunner implements HostedRunner {
  answer: StartOutcome = { state: 'connected' };
  readonly started: { key: string; launch: HostedLaunch }[] = [];
  readonly running = new Map<string, RunnerStatus>();

  start(key: string, launch: HostedLaunch): Promise<StartOutcome> {
    this.started.push({ key, launch });
    if ('state' in this.answer) { this.running.set(key, { state: this.answer.state, pid: 4120, restartsLastHour: 0, output: 'random.serving' }); }
    return Promise.resolve(this.answer);
  }

  stop(key: string): Promise<void> {
    this.running.set(key, { state: 'stopped', restartsLastHour: 0, output: '' });
    return Promise.resolve();
  }

  status(key: string): RunnerStatus | undefined {
    return this.running.get(key);
  }
}

describe('hosting systems written here', () => {
  const made: string[] = [];
  afterEach(() => { made.length = 0; });

  function setup(tests?: SystemTests) {
    const builds = new FakeBuilds();
    const runner = new FakeRunner();
    const data = folder('fs-data');
    made.push(data);
    const hosting = new Hosting({ builds, runner, ...(tests === undefined ? {} : { tests }), hubUrl: 'ws://127.0.0.1:4551/link', host, dataDir: data, limits: { connectTimeout: 30_000, problems: 2, outputTail: 20 } });
    const grants: InstallSubject[] = [];
    const grant = (subject: InstallSubject) => { grants.push(subject); return Promise.resolve({ token: 'tok_1', expiresAt: 1 }); };
    return { builds, runner, hosting, grants, grant };
  }

  it('refuses a folder that does not build with its file:line:col lines, before any card', async () => {
    const { builds, hosting } = setup();
    builds.problems = ['server/impl.ts:3:10 Cannot find name fn.', 'server/impl.ts:9:5 Property number does not exist on g.', 'shared/index.ts:1:1 Unused import.'];
    const refused = await hosting.preview(folder(), {}, signal).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InstallRefused);
    expect(String(refused)).toContain('server/impl.ts:3:10 Cannot find name fn.');
    expect(String(refused)).toContain('and 1 more');
  });

  it('refuses a folder without a readable system.json, and an instance name that is not one, saying why', async () => {
    const { hosting } = setup();
    const refusal = (dir: string, instance?: string) => hosting.preview(dir, { instance }, signal).then(() => '', (error: unknown) => (error instanceof InstallRefused ? error.message : 'other'));
    const dir = folder();
    expect(await refusal(dir, 'Not An Instance')).toContain("isn't an instance name");
    expect(await refusal(dir, 'versions')).toContain("isn't an instance name");
    writeFileSync(join(dir, 'system.json'), '{ nope');
    expect(await refusal(dir)).toContain("system.json isn't JSON");
    writeFileSync(join(dir, 'system.json'), '{"name":"random"}');
    expect(await refusal(dir)).toContain('system.json is wrong:');
    expect(await refusal(join(dir, 'missing'))).toContain('has no system.json');
  });

  it('shows a card bound to the build, starts exactly that bundle with a one-time token, and reports it connected', async () => {
    const { runner, hosting, grants, grant } = setup();
    const dir = folder();
    const preview = await hosting.preview(dir, {}, signal);
    expect(preview.title).toBe('Install random 0.1.0 on fs/main');
    expect(preview.subject).toMatchObject({ kind: 'system-install', system: 'random', instance: 'main', bundleHash: 'b-source-1', sourceHash: 'source-1', host });
    expect(JSON.stringify(preview.parts)).toContain('random/random (read)');
    if (preview.subject === undefined) { throw new Error('no subject'); }
    const result = await hosting.install(dir, preview.subject, grant, signal);
    expect(result).toMatchObject({ system: 'random', instance: 'main', status: 'connected', fns: ['random/random'] });
    expect(grants).toHaveLength(1);
    const launch = runner.started[0]?.launch;
    expect(launch?.env).toMatchObject({ HARNESS_PAIRING_TOKEN: 'tok_1', HARNESS_INSTANCE: 'main', HARNESS_LOG_JSON: 'true' });
    // only the hub, its folders and the SDK's own settings: never fs's environment
    expect(Object.keys(launch?.env ?? {}).every((name) => name.startsWith('HARNESS_'))).toBe(true);
    expect(launch?.entry.replaceAll('\\', '/')).toContain('/hosted/random/versions/b-source-1/server/main.js');
    // what its approved contract declares: a path under its data folder, and its hosts
    expect(launch?.network).toEqual(['api.example.com']);
    expect(launch?.files.read.map((path) => path.replaceAll('\\', '/'))).toEqual([expect.stringMatching(/\/hosted\/random\/main\/data\/shared$/)]);
    expect(await hosting.status()).toMatchObject([{ system: 'random', state: 'connected', pid: 4120 }]);
  });

  it('runs the folder tests before the card and puts them beside the scan, with the source folder on the subject', async () => {
    const report: SystemTestReport = {
      system: SystemName.parse('random'), version: '0.1.0', ranAt: 1, duration: 40, passed: 3, failed: 1, skipped: 1,
      cases: [{ file: 'server/impl.test.ts', name: 'rolls a die', status: 'failed', duration: 3, error: 'expected 7 to be at most 6' }],
    };
    const ran: string[] = [];
    const { hosting } = setup({ run: (dir) => { ran.push(dir); return Promise.resolve(report); } });
    const dir = folder();
    const preview = await hosting.preview(dir, {}, signal);
    expect(ran).toEqual([dir]);
    expect(preview.checks).toEqual({ scan: { size: 2048, builtins: [], concerns: [], urls: [], hosts: [] }, tests: report });
    expect(preview.subject?.source).toBe(dir);
    const plain = await setup().hosting.preview(folder(), {}, signal);
    expect(plain.checks?.tests).toBeUndefined();
    expect(JSON.stringify(plain.parts)).toContain('Bundle: 2 KB.');
  });

  it('refuses a folder changed after approval, and an update keeps its key and shows the diff', async () => {
    const { builds, hosting, grants, grant } = setup();
    const dir = folder();
    const first = (await hosting.preview(dir, {}, signal)).subject;
    if (first === undefined) { throw new Error('no subject'); }
    await hosting.install(dir, first, grant, signal);
    builds.source = 'source-2';
    builds.fns = ['random/random (read)', 'random/dice (read)'];
    await expect(hosting.install(dir, first, grant, signal)).rejects.toThrow('The folder changed after approval');
    const update = await hosting.preview(dir, {}, signal);
    expect(update.title).toBe('Update random 0.1.0 → 0.1.0 on fs/main');
    expect(JSON.stringify(update.parts)).toContain('adds random/dice (read)');
    expect(update.subject?.replaces).toMatchObject({ version: '0.1.0' });
    if (update.subject === undefined) { throw new Error('no subject'); }
    await hosting.install(dir, update.subject, grant, signal);
    // the hosted system already has its key: no second token
    expect(grants).toHaveLength(1);
  });

  it('gives the model the exit code and the end of the output when it crashes before connecting', async () => {
    const { runner, hosting, grant } = setup();
    const dir = folder();
    const subject = (await hosting.preview(dir, {}, signal)).subject;
    if (subject === undefined) { throw new Error('no subject'); }
    runner.answer = { exited: { code: 1, output: 'boot\nTypeError: g.number is not a function' } };
    await expect(hosting.install(dir, subject, grant, signal)).rejects.toThrow(/exited \(code 1\)[\s\S]*output:\ner is not a function$/);
    expect(await hosting.records()).toEqual([]);
  });

  it('brings the running version back when an update fails, and never starts a bundle changed since approval', async () => {
    const { builds, runner, hosting, grant } = setup();
    const dir = folder();
    const first = (await hosting.preview(dir, {}, signal)).subject;
    if (first === undefined) { throw new Error('no subject'); }
    await hosting.install(dir, first, grant, signal);
    builds.source = 'source-2';
    const update = (await hosting.preview(dir, {}, signal)).subject;
    if (update === undefined) { throw new Error('no subject'); }
    runner.answer = { exited: { code: 1, output: 'boom' } };
    await expect(hosting.install(dir, update, grant, signal)).rejects.toThrow('exited (code 1)');
    expect(runner.started.at(-1)?.launch.entry.replaceAll('\\', '/')).toContain('/versions/b-source-1/');
    expect(await hosting.records()).toMatchObject([{ bundleHash: 'b-source-1' }]);
    runner.answer = { state: 'connected' };
    const record = await hosting.record('random', 'main');
    if (record === undefined) { throw new Error('no record'); }
    writeFileSync(record.entry, 'tampered');
    const starts = runner.started.length;
    await expect(hosting.restart('random', undefined)).rejects.toThrow('changed since it was approved');
    expect(runner.started).toHaveLength(starts);
  });

  it('refuses the hub\'s name', async () => {
    const { hosting } = setup();
    await expect(hosting.preview(folder('hub'), {}, signal)).rejects.toThrow('reserved for the hub');
  });

  it('runs with the permissions of the approved build, not system.json read again, and installs one at a time', async () => {
    const { runner, hosting, grant } = setup();
    const dir = folder();
    const subject = (await hosting.preview(dir, {}, signal)).subject;
    if (subject === undefined) { throw new Error('no subject'); }
    writeFileSync(join(dir, 'system.json'), JSON.stringify({ format: 1, name: 'random', version: '0.1.0', description: 'Random numbers.', protocol: 1, server: { entry: 'server/main.ts', external: {} }, permissions: { childProcess: true } }));
    await Promise.all([hosting.install(dir, subject, grant, signal), hosting.install(dir, subject, grant, signal)]);
    expect(runner.started.map((start) => start.launch.permissions?.childProcess)).toEqual([undefined, undefined]);
  });

  it('restarts the approved bundle, stops it for good, and removes its folders', async () => {
    const { runner, hosting, grant } = setup();
    const dir = folder();
    const subject = (await hosting.preview(dir, {}, signal)).subject;
    if (subject === undefined) { throw new Error('no subject'); }
    await hosting.install(dir, subject, grant, signal);
    expect(await hosting.restart('random', undefined)).toBe('connected');
    expect(runner.started.at(-1)?.launch.env['HARNESS_PAIRING_TOKEN']).toBeUndefined();
    expect(await hosting.stop('random', undefined, false)).toEqual({ stopped: true, removed: false });
    expect(await hosting.records()).toMatchObject([{ start: false }]);
    expect(await hosting.startAll()).toEqual([]);
    expect(await hosting.stop('random', undefined, true)).toEqual({ stopped: true, removed: true });
    expect(await hosting.records()).toEqual([]);
    await expect(hosting.restart('random', undefined)).rejects.toThrow('isn\'t hosted here. Nothing is.');
  });

  it('previews unchanged code again without removing the running bundle folder, and builds one preview at a time', async () => {
    const { builds, runner, hosting, grant } = setup();
    const dir = folder();
    const first = (await hosting.preview(dir, {}, signal)).subject;
    if (first === undefined) { throw new Error('no subject'); }
    await hosting.install(dir, first, grant, signal);
    // a file in the running folder that a removal would take with it
    const marker = join(hosting.versionFolder('random', 'b-source-1'), 'running.txt');
    writeFileSync(marker, 'here');
    const again = await Promise.all([hosting.preview(dir, {}, signal), hosting.preview(dir, {}, signal)]);
    expect(again.map((card) => card.subject?.bundleHash)).toEqual(['b-source-1', 'b-source-1']);
    expect(readFileSync(marker, 'utf8')).toBe('here');
    expect(builds.builds).toBe(3);
    expect(await hosting.restart('random', undefined)).toBe('connected');
    expect(runner.started.at(-1)?.launch.entry.replaceAll('\\', '/')).toContain('/versions/b-source-1/server/main.js');
  });

  it('caps problem lines and diffs fns by name', () => {
    expect(capped(['a', 'b', 'c'], 2)).toBe('a\nb\nand 1 more');
    expect(fnsDiff(['x/a (read)', 'x/b (read)'], ['x/a (write)', 'x/c (read)'])).toEqual(['adds x/c (read)', 'removes x/b (read)', 'changes x/a (write) (was x/a (read))']);
  });
});
