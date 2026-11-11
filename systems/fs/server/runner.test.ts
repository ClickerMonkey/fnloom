import { CrashPolicy, type ProcessCommand, type ProcessExit, type ProcessStarter, type SupervisedProcess } from '@harness/sdk/server';
import { describe, expect, it } from 'vitest';
import type { HostedLaunch } from './hosting.ts';
import { SupervisedRunner, type ConnectProbe } from './runner.ts';

/** A process the test ends by hand. */
class FakeProcess implements SupervisedProcess {
  readonly pid: number;
  readonly exited: Promise<ProcessExit>;
  end: (exit: ProcessExit) => void = () => undefined;

  constructor(pid: number) {
    this.pid = pid;
    this.exited = new Promise((done) => { this.end = done; });
  }

  kill(): void {
    this.end({ code: 1, output: 'killed' });
  }
}

/** Starts fake processes and keeps what it was asked. */
class FakeStarter implements ProcessStarter {
  readonly started: { command: ProcessCommand; process: FakeProcess }[] = [];

  launch(command: ProcessCommand): SupervisedProcess {
    const process = new FakeProcess(100 + this.started.length);
    this.started.push({ command, process });
    return process;
  }
}

const launch: HostedLaunch = {
  entry: '/hosted/random/versions/b1/server/main.js', cwd: '/hosted/random/versions/b1', writes: ['/hosted/random/main/state', '/hosted/random/main/data'],
  env: { HARNESS_INSTANCE: 'main' }, permissions: undefined,
};

function setup(probe: ConnectProbe) {
  const starter = new FakeStarter();
  let now = 0;
  const runner = new SupervisedRunner({
    starter, policy: new CrashPolicy({ maxWait: 10, restartCode: 75, clock: () => now }), restart: { policy: 'on-failure', backoff: 1, maxPerHour: 2 },
    reads: ['/repo/node_modules'], probe, every: 1, wait: (ms) => { now += ms; return new Promise((done) => { setTimeout(done, 1); }); }, now: () => now, log: () => undefined,
  });
  return { starter, runner };
}

const settle = () => new Promise((done) => { setTimeout(done, 30); });

describe('the hosted runner', () => {
  it('starts under the permission model, waits for the hub to see it, and reports it connected', async () => {
    let tries = 0;
    const { starter, runner } = setup(() => Promise.resolve((tries += 1) >= 3 ? 'connected' : undefined));
    expect(await runner.start('random/main', launch, 1_000)).toEqual({ state: 'connected' });
    const args = starter.started[0]?.command.args ?? [];
    expect(args[0]).toBe('--permission');
    expect(args.some((arg) => arg.startsWith('--allow-fs-write=') && arg.includes('state'))).toBe(true);
    expect(args.some((arg) => arg.startsWith('--allow-fs-read=') && arg.includes('node_modules'))).toBe(true);
    expect(args).not.toContain('--allow-child-process');
    expect(args.at(-1)).toBe(launch.entry);
    expect(runner.status('random/main')).toMatchObject({ state: 'connected', pid: 100, restartsLastHour: 0 });
  });

  it('gives an exit before connecting back with its output, and stops one that never connects', async () => {
    const { starter, runner } = setup(() => Promise.resolve(undefined));
    const starting = runner.start('random/main', launch, 1_000);
    await settle();
    starter.started[0]?.process.end({ code: 1, output: 'TypeError: boom' });
    expect(await starting).toEqual({ exited: { code: 1, output: 'TypeError: boom' } });
    expect(await runner.start('random/main', launch, 5)).toEqual({ timedOut: { output: 'killed' } });
    expect(runner.status('random/main')?.state).toBe('stopped');
  });

  it('restarts a crash after it connected, and disables it after too many in an hour', async () => {
    const { starter, runner } = setup(() => Promise.resolve('connected'));
    await runner.start('random/main', launch, 1_000);
    starter.started[0]?.process.end({ code: 1, output: 'crash 1' });
    await settle();
    expect(starter.started).toHaveLength(2);
    expect(runner.status('random/main')).toMatchObject({ state: 'connected', restartsLastHour: 1 });
    starter.started[1]?.process.end({ code: 1, output: 'crash 2' });
    await settle();
    starter.started[2]?.process.end({ code: 1, output: 'crash 3' });
    await settle();
    expect(runner.status('random/main')).toMatchObject({ state: 'disabled', output: 'crash 3' });
    expect(starter.started).toHaveLength(3);
  });
});
