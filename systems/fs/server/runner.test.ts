import { CrashPolicy, type ProcessCommand, type ProcessExit, type ProcessStarter, type SupervisedProcess } from '@harness/sdk/server';
import { describe, expect, it } from 'vitest';
import type { HostedLaunch } from './hosting.ts';
import { SupervisedRunner } from './runner.ts';

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

/** What a hosted process's SDK prints when its status changes (`HARNESS_LOG_JSON`). */
function statusLine(status: string): string {
  return `${JSON.stringify({ tms: '2026-11-11T00:00:00.000Z', level: 'info', msg: 'system.status', status })}\n`;
}

function setup() {
  const starter = new FakeStarter();
  let now = 0;
  const runner = new SupervisedRunner({
    starter, policy: new CrashPolicy({ maxWait: 10, restartCode: 75, clock: () => now }), restart: { policy: 'on-failure', backoff: 1, maxPerHour: 2 },
    reads: ['/repo/node_modules'], every: 1, wait: (ms) => { now += ms; return new Promise((done) => { setTimeout(done, 1); }); }, now: () => now, log: () => undefined,
  });
  return { starter, runner };
}

const settle = () => new Promise((done) => { setTimeout(done, 30); });

describe('the hosted runner', () => {
  it('starts under the permission model, waits for that process to say the hub welcomed it, and reports it connected', async () => {
    const { starter, runner } = setup();
    const starting = runner.start('random/main', launch, 1_000);
    await settle();
    const say = starter.started[0]?.command.onOutput;
    // a line split across pieces, other output, and "connecting" don't count
    say?.('random.serving\n');
    say?.(statusLine('connecting'));
    const connected = statusLine('connected');
    say?.(connected.slice(0, 20));
    await settle();
    expect(runner.status('random/main')?.state).toBe('starting');
    say?.(connected.slice(20));
    expect(await starting).toEqual({ state: 'connected' });
    const args = starter.started[0]?.command.args ?? [];
    expect(args[0]).toBe('--permission');
    expect(args.some((arg) => arg.startsWith('--allow-fs-write=') && arg.includes('state'))).toBe(true);
    expect(args.some((arg) => arg.startsWith('--allow-fs-read=') && arg.includes('node_modules'))).toBe(true);
    expect(args).not.toContain('--allow-child-process');
    expect(args.at(-1)).toBe(launch.entry);
    expect(runner.status('random/main')).toMatchObject({ state: 'connected', pid: 100, restartsLastHour: 0 });
  });

  it('gives an exit before connecting back with its output, and stops one that never connects', async () => {
    const { starter, runner } = setup();
    const starting = runner.start('random/main', launch, 1_000);
    await settle();
    starter.started[0]?.process.end({ code: 1, output: 'TypeError: boom' });
    expect(await starting).toEqual({ exited: { code: 1, output: 'TypeError: boom' } });
    expect(await runner.start('random/main', launch, 5)).toEqual({ timedOut: { output: 'killed' } });
    expect(runner.status('random/main')?.state).toBe('stopped');
  });

  it('restarts a crash after it connected, and disables it after too many in an hour', async () => {
    const { starter, runner } = setup();
    const starting = runner.start('random/main', launch, 1_000);
    await settle();
    starter.started[0]?.command.onOutput?.(statusLine('connected'));
    await starting;
    starter.started[0]?.process.end({ code: 1, output: 'crash 1' });
    await settle();
    expect(starter.started).toHaveLength(2);
    // the old process's lines don't count for the new one
    starter.started[0]?.command.onOutput?.(statusLine('connected'));
    await settle();
    expect(runner.status('random/main')?.state).toBe('starting');
    starter.started[1]?.command.onOutput?.(statusLine('connected'));
    await settle();
    expect(runner.status('random/main')).toMatchObject({ state: 'connected', restartsLastHour: 1 });
    starter.started[1]?.process.end({ code: 1, output: 'crash 2' });
    await settle();
    starter.started[2]?.process.end({ code: 1, output: 'crash 3' });
    await settle();
    expect(runner.status('random/main')).toMatchObject({ state: 'disabled', output: 'crash 3' });
    expect(starter.started).toHaveLength(3);
  });
});
