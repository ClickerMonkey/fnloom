import { MAIN_INSTANCE, SystemName, type HostRefusal } from '@harness/core';
import { CrashPolicy, type ProcessCommand, type ProcessExit, type ProcessStarter, type SupervisedProcess } from '@harness/sdk/server';
import { describe, expect, it } from 'vitest';
import type { HostedLaunch } from './hosting.ts';
import { SupervisedRunner, type NetworkGate } from './runner.ts';

/** A gate that keeps what it was told to let through, and can be made to refuse a host. */
class FakeGate implements NetworkGate {
  closed = false;
  readonly allow: readonly string[];
  readonly refuse: (refusal: { host: string; port: number }) => void;

  constructor(allow: readonly string[], refuse: (refusal: { host: string; port: number }) => void) {
    this.allow = allow;
    this.refuse = refuse;
  }

  start(): Promise<string> { return Promise.resolve('http://127.0.0.1:9'); }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

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
  ref: { system: SystemName.parse('random'), instance: MAIN_INSTANCE }, files: { read: ['/shared/notes'], write: ['/shared/out'] }, network: ['api.example.com'],
  entry: '/hosted/random/versions/b1/server/main.js', cwd: '/hosted/random/versions/b1', writes: ['/hosted/random/main/state', '/hosted/random/main/data'],
  env: { HARNESS_INSTANCE: 'main' }, permissions: undefined,
};

/** What a hosted process's SDK prints when its status changes (`HARNESS_LOG_JSON`). */
function statusLine(status: string): string {
  return `${JSON.stringify({ tms: '2026-11-11T00:00:00.000Z', level: 'info', msg: 'system.status', status })}\n`;
}

function setup() {
  const starter = new FakeStarter();
  const gates: FakeGate[] = [];
  const refusals: HostRefusal[] = [];
  let now = 0;
  const runner = new SupervisedRunner({
    gate: (allow, refused) => { const gate = new FakeGate(allow, refused); gates.push(gate); return gate; }, direct: [{ host: 'hub.local', port: 4300 }], refused: (refusal) => { refusals.push(refusal); },
    starter, policy: new CrashPolicy({ maxWait: 10, restartCode: 75, clock: () => now }), restart: { policy: 'on-failure', backoff: 1, maxPerHour: 2 },
    reads: ['/repo/node_modules'], every: 1, wait: (ms) => { now += ms; return new Promise((done) => { setTimeout(done, 1); }); }, now: () => now, log: () => undefined,
  });
  return { starter, runner, gates, refusals };
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

  it('lets it reach only its declared paths and hosts, and reports what it was refused', async () => {
    const { starter, runner, gates, refusals } = setup();
    const starting = runner.start('random/main', launch, 1_000);
    await settle();
    const started = starter.started[0]?.command;
    started?.onOutput?.(statusLine('connected'));
    await starting;
    const args = started?.args ?? [];
    expect(args.some((arg) => arg.startsWith('--allow-fs-read=') && arg.includes('notes'))).toBe(true);
    expect(args.some((arg) => arg.startsWith('--allow-fs-write=') && arg.includes('out'))).toBe(true);
    expect(started?.env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1', NO_PROXY: 'hub.local', HARNESS_INSTANCE: 'main' });
    // its sockets are held to the proxy and the hub by the guard it loads first
    expect(started?.env).toMatchObject({ HARNESS_NETWORK_ALLOW: '127.0.0.1:9,hub.local:4300' });
    expect(args.at(-3)).toBe('--require');
    expect(args.at(-2)).toMatch(/hosted-network-guard\.ts$/);
    expect(args.some((arg) => arg.startsWith('--allow-fs-read=') && arg.endsWith('socket-guard.ts'))).toBe(true);
    expect(gates[0]?.allow).toEqual(['api.example.com', 'hub.local']);

    gates[0]?.refuse({ host: 'evil.example.net', port: 443 });
    started?.onOutput?.('harness.network.refused 10.0.0.5:11434\n');
    started?.onOutput?.("  code: 'ERR_ACCESS_DENIED',\n  permission: 'FileSystemRead',\n  resource: '/etc/passwd'\n}\n");
    expect(refusals).toEqual([
      { instance: launch.ref, rule: 'network', attempt: 'evil.example.net:443', detail: "random tried to reach evil.example.net, which its grants.network doesn't name" },
      { instance: launch.ref, rule: 'network', attempt: '10.0.0.5:11434', detail: "random tried to reach 10.0.0.5, which its grants.network doesn't name" },
      { instance: launch.ref, rule: 'files', attempt: '/etc/passwd', detail: "random tried FileSystemRead on /etc/passwd, which its grants.files doesn't name" },
    ]);
    await runner.stop('random/main');
    expect(gates[0]?.closed).toBe(true);
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
