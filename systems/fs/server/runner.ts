/**
 * `HostedRunner` over the SDK's shared supervision (`@harness/sdk/server` `supervise.ts`): each hosted system runs as a
 * child of fs, started by a `ProcessStarter` (the scrubbed environment, fs's tsx loader first) under Node's permission
 * model (`permissionArgs`: read its bundle and the loader, write its own folders, child processes and workers only when
 * `system.json` asks, plus the paths its contract's `grants.files` names), its network through an allowlist proxy of the
 * hosts its `grants.network` names (`proxyEnv`; the hub link goes direct) with its sockets held to that proxy and the hub
 * (the SDK's `NETWORK_GUARD`, preloaded, so a raw socket or a client with its own agent can't go around the proxy; the
 * hub's supervisor runs its installed instances the same way), and restarted after a crash by the `CrashPolicy`
 * (backoff doubling, a cap per hour, then disabled). A start waits until that very process says the hub welcomed it (its `system.status` log line, `connected`
 * or `needs-config`: the SDK writes it once the hub accepted its key and, for a first install, the approved contract),
 * it exits, or the time is up. Another instance of the system, or the old process of an update, never counts. A host
 * the proxy or the socket guard refuses, and a path Node's permission model refuses (read from what the child prints), are reported to the
 * hub as that instance's refusals.
 */
import {
  AccessDeniedReader, NETWORK_GUARD, NETWORK_GUARD_FILES, guardedEnv, permissionArgs, refusedOfLine, statusOfLine,
  type CrashPolicy, type Endpoint, type NetworkGate as SdkNetworkGate, type ProcessStarter, type ProxyRefusal, type SupervisedProcess,
} from '@harness/sdk/server';
import type { HostRefusal, RestartPolicy } from '@harness/core';
import type { HostedStateValue } from '../shared/hosting.ts';
import type { HostedLaunch, HostedRunner, RunnerStatus, StartOutcome } from './hosting.ts';

/** An hour, the window restarts are counted in. */
const HOUR = 3_600_000;

/** A child's network gate (the SDK's `AllowlistProxy`): listens, and is closed when the child is stopped for good. */
export type NetworkGate = Pick<SdkNetworkGate, 'start' | 'close'>;

/** What the runner is built from. */
export interface RunnerDeps {
  /** A gate letting through only `allow`, telling `refused` of every other host. */
  readonly gate: (allow: readonly string[], refused: (refusal: ProxyRefusal) => void) => NetworkGate;
  /** Where every child connects directly, never through its gate (the hub). */
  readonly direct: readonly Endpoint[];
  /** Sends a refusal to the hub. */
  readonly refused: (refusal: HostRefusal) => void;
  readonly starter: ProcessStarter;
  readonly policy: CrashPolicy;
  readonly restart: RestartPolicy;
  /** Folders every child may read besides its own (the loader it runs under). */
  readonly reads: readonly string[];
  /** How often a start looks at what the process said. */
  readonly every: number;
  readonly wait: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (key: string, fields: Record<string, string | number>) => void;
}

/** One hosted process and what is known of it. */
interface Entry {
  launch: HostedLaunch;
  process: SupervisedProcess | undefined;
  state: HostedStateValue;
  output: string;
  restarts: number[];
  stopping: boolean;
  /** What the current process last said of the hub: welcomed (connected, or waiting for config), or not yet. */
  said: 'connected' | 'needs-config' | undefined;
  /** Its network gate and the URL it listens at, for every process of this entry. */
  gate: { readonly gate: NetworkGate; readonly url: string };
}

/** Runs hosted systems as supervised children. */
export class SupervisedRunner implements HostedRunner {
  readonly #deps: RunnerDeps;
  readonly #entries = new Map<string, Entry>();

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
  }

  async start(key: string, launch: HostedLaunch, timeout: number): Promise<StartOutcome> {
    await this.stop(key);
    this.#deps.policy.forget(key);
    const gate = this.#deps.gate([...launch.network, ...this.#directHosts()], (refusal) => { this.#refusedHost(launch, refusal.host, `${refusal.host}:${String(refusal.port)}`); });
    const entry: Entry = { launch, process: undefined, state: 'starting', output: '', restarts: [], stopping: false, said: undefined, gate: { gate, url: await gate.start() } };
    this.#entries.set(key, entry);
    const child = this.#spawn(key, entry);
    const deadline = this.#deps.now() + timeout;
    const exited = child.exited.then((exit) => ({ exit }));
    for (;;) {
      const seen = await Promise.race([exited, this.#deps.wait(this.#deps.every).then(() => undefined)]);
      // an exit before the hub saw it is the model's to fix: no restart for that one
      if (seen !== undefined) {
        entry.stopping = true;
        entry.state = 'crashed';
        await entry.gate.gate.close();
        return { exited: { code: seen.exit.code, output: seen.exit.output } };
      }
      const state = entry.said;
      if (state !== undefined) { entry.state = state; return { state }; }
      if (this.#deps.now() >= deadline) {
        await this.stop(key);
        return { timedOut: { output: entry.output } };
      }
    }
  }

  async stop(key: string): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry === undefined) { return; }
    entry.stopping = true;
    entry.state = 'stopped';
    const child = entry.process;
    if (child !== undefined) {
      child.kill();
      await child.exited;
    }
    await entry.gate.gate.close();
  }

  status(key: string): RunnerStatus | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) { return undefined; }
    const since = this.#deps.now() - HOUR;
    return {
      state: entry.state,
      ...(entry.process?.pid === undefined || entry.state === 'stopped' || entry.state === 'disabled' ? {} : { pid: entry.process.pid }),
      restartsLastHour: entry.restarts.filter((at) => at > since).length,
      output: entry.output,
    };
  }

  /** Launch the entry's process and follow its exit with the crash policy. */
  #spawn(key: string, entry: Entry): SupervisedProcess {
    const { launch } = entry;
    const grants = {
      read: [launch.cwd, ...this.#deps.reads, ...NETWORK_GUARD_FILES, ...launch.files.read], write: [...launch.writes, ...launch.files.write],
      ...(launch.permissions === undefined ? {} : { permissions: launch.permissions }),
    };
    entry.said = undefined;
    let partial = '';
    const denied = new AccessDeniedReader();
    // only this process's own lines count: a new spawn starts again from nothing
    const heard = (text: string) => {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        this.#heard(entry, child, line);
        const target = refusedOfLine(line);
        if (target !== undefined) { this.#refusedHost(launch, target.replace(/:\d+$/, ''), target); }
        const access = denied.line(line);
        if (access !== undefined) {
          const what = access.resource ?? 'a path';
          this.#deps.refused({ instance: launch.ref, rule: 'files', attempt: what, detail: `${launch.ref.system} tried ${access.permission} on ${what}, which its grants.files doesn't name` });
        }
      }
    };
    const env = {
      ...launch.env, ...guardedEnv(entry.gate.url, this.#deps.direct),
    };
    const args = [...permissionArgs(grants), '--require', NETWORK_GUARD, launch.entry];
    const child: SupervisedProcess = this.#deps.starter.launch({ run: process.execPath, args, cwd: launch.cwd, env, onOutput: heard });
    entry.process = child;
    if (child.pid !== undefined) { launch.spawned(child.pid); }
    void child.exited.then(async (exit) => {
      entry.output = exit.output;
      if (this.#entries.get(key) !== entry) { return; }
      const decision = this.#deps.policy.decide(key, this.#deps.restart, exit, entry.stopping);
      this.#deps.log('fs.hosted.exited', { key, code: exit.code, action: decision.action });
      switch (decision.action) {
        case 'stopped':
          // an asked-for stop closes the gate itself
          if (!entry.stopping) { entry.state = 'stopped'; await entry.gate.gate.close(); }
          return;
        case 'give-up': entry.state = 'disabled'; await entry.gate.gate.close(); return;
        case 'restart': entry.state = 'crashed'; await this.#deps.wait(decision.wait); break;
        case 'restart-now': break;
      }
      if (entry.stopping || this.#entries.get(key) !== entry) { return; }
      entry.restarts.push(this.#deps.now());
      entry.state = 'starting';
      const again = this.#spawn(key, entry);
      // once the hub sees it again it is connected; until then it is starting
      const watch = { gone: false };
      void again.exited.then(() => { watch.gone = true; });
      // a function, so each check reads the entry as it is after the awaits
      const waiting = (): boolean => !watch.gone && entry.process === again && entry.state === 'starting';
      while (waiting()) {
        const state = entry.said;
        if (state !== undefined) { entry.state = state; break; }
        await this.#deps.wait(this.#deps.every);
      }
    });
    return child;
  }

  /** The hosts of the direct endpoints (the hub's), which skip the proxy. */
  #directHosts(): string[] {
    return [...new Set(this.#deps.direct.map((endpoint) => endpoint.host))];
  }

  /** Tell the hub the instance tried to reach `host` (`attempt` is what it asked for), which its grants don't name. */
  #refusedHost(launch: HostedLaunch, host: string, attempt: string): void {
    this.#deps.refused({ instance: launch.ref, rule: 'network', attempt, detail: `${launch.ref.system} tried to reach ${host}, which its grants.network doesn't name` });
  }

  /** A line the entry's process printed: a status line of the current process is what it says of the hub. */
  #heard(entry: Entry, child: SupervisedProcess, line: string): void {
    if (entry.process !== child) { return; }
    const status = statusOfLine(line);
    if (status === 'connected' || status === 'needs-config') {
      entry.said = status;
      // a running one that changes between the two (its config changed) shows it
      if (entry.state === 'connected' || entry.state === 'needs-config') { entry.state = status; }
    } else if (status === 'disconnected' || status === 'connecting') {
      entry.said = undefined;
    }
  }
}
