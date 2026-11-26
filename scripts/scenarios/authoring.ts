/**
 * What the runner does for the third set (cases 81-84, docs/plans/scenarios-3-2026-11-26.md): a chat writes a system
 * of its own and installs it with fs/install_system.
 *
 * - **The workspace** (`makeWorkspace`): a system builds only where its imports resolve (`@harness/sdk` and the rest
 *   from the checkout's `node_modules`) and its `tsconfig.json` reaches the checkout's base config and project
 *   references, so a system written in the rep's fake home folder (outside any repository) can't build. The rep gives
 *   fs a second root, `projects`, inside the checkout's ignored `.harness-test/` (in the rep's own folder, so it is
 *   fresh each rep), holding `systems/template`: the template system copied with its outward paths rebased the way
 *   `harness system new --dir` rebases them, so `cp -r systems/template systems/<name>` (the guide's way without the
 *   CLI) and `npx harness system new <name>` both make a folder that builds. No links into the checkout: a copy, so
 *   nothing deleted there can reach the checkout's own files.
 * - **The admin's review step** (`SystemWatch`): an approved install card leaves a new system `installed`, offering
 *   nothing until an admin reviews it on its review page and goes live, and a code change to a live system waits as a
 *   pending review. The simulated person can only answer what the chat shows, so while a case plays the runner does that
 *   page's step as the case's person (an admin): it goes live with a system the case installed once it connects, and
 *   approves its pending review. Each is noted on the case's systems (`events`). It also watches what each new system
 *   ran as (its versions, keys and data) for the hard checks, and the case's model cost for its cap.
 * - **Clean-up** (`removeInstalled`, `killLeftovers`): after each case, every system it installed is stopped (one fs
 *   hosts through fs/stop_system with `remove`, its hosted folders deleted, the confirm answered yes; one the hub
 *   installed, `hub/install_system`, by the hub), removed from the hub, and its folder in
 *   the workspace deleted, so the next case starts with the rep's own systems only. After the rep's stack stops, any
 *   hosted process still running its bundle is killed.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isSettled, QualifiedName, SystemName, type SessionId } from '@harness/core';
import { relocate } from '../../packages/cli/src/commands/new.ts';
import type { SignedIn } from '../hub-client.ts';
import { clientInfo, SessionWatch } from '../session.ts';
import { ROOT } from '../stack.ts';
import type { AuthoringExpectation } from './cases.ts';
import { z } from 'zod';
import { HostedProcess } from '../../systems/fs/server/stale.ts';
import type { SeenSystem, SystemsSeen } from './records.ts';

/** The template system in this checkout. */
export const TEMPLATE = join(ROOT, 'systems', 'template');
/** The name of the fs root that holds the workspace. */
export const WORKSPACE_ROOT = 'projects';
/** A `tsconfig.json`, as far as the copy reads it. */
const Tsconfig = z.looseObject({ compilerOptions: z.looseObject({ outDir: z.string().optional(), tsBuildInfoFile: z.string().optional() }).optional() });

/** Files of the template that are not source (what `harness system new` leaves out too). */
const SKIPPED = new Set(['node_modules', 'dist', '.types']);

/**
 * Make the authoring workspace in a rep's folder: `<folder>/workspace/systems/template`, the template with the outward
 * paths of its `tsconfig.json` and `package.json` rebased to reach the checkout from there. Refuses a folder outside
 * the checkout (nothing would resolve) and gives the workspace's path.
 */
export function makeWorkspace(folder: string): string {
  const workspace = join(folder, 'workspace');
  const within = relative(ROOT, workspace);
  if (within.startsWith('..') || isAbsolute(within)) { throw new Error(`the authoring workspace ${workspace} must be inside the checkout ${ROOT}, where a system's imports resolve`); }
  rmSync(workspace, { recursive: true, force: true });
  const target = join(workspace, 'systems', 'template');
  mkdirSync(target, { recursive: true });
  const copy = (from: string): void => {
    for (const name of readdirSync(from)) {
      if (SKIPPED.has(name)) { continue; }
      const source = join(from, name);
      const path = relative(TEMPLATE, source);
      if (statSync(source).isDirectory()) { mkdirSync(join(target, path), { recursive: true }); copy(source); continue; }
      if (/(^|[\\/])package\.json$/.test(path)) {
        writeFileSync(join(target, path), relocate(path, readFileSync(source, 'utf8'), TEMPLATE, target));
      } else if (/(^|[\\/])tsconfig\.json$/.test(path)) {
        // the base config and the references reach the checkout; the build output stays in the workspace (its own
        // `.types/`), so a copy never writes over the checkout's own template build
        const text = readFileSync(source, 'utf8');
        const original = Tsconfig.parse(JSON.parse(text));
        const moved = Tsconfig.parse(JSON.parse(relocate(path, text, TEMPLATE, target)));
        writeFileSync(join(target, path), `${JSON.stringify({ ...moved, compilerOptions: { ...moved.compilerOptions, outDir: original.compilerOptions?.outDir, tsBuildInfoFile: original.compilerOptions?.tsBuildInfoFile } }, null, 2)}\n`);
      } else {
        cpSync(source, join(target, path));
      }
    }
  };
  copy(TEMPLATE);
  return workspace;
}

/** What a hub call answered about one system, as the watch keeps it. */
interface Watched {
  readonly name: string;
  status: string;
  stage: string;
  readonly versions: string[];
  readonly keys: Set<string>;
  instances: number;
  hosted: boolean;
  hubInstalled: boolean;
  readonly records: Map<string, number>;
  readonly files: Map<string, number>;
  readonly events: string[];
  /** The review hash it went live with or approved last, so each is done once. */
  readonly decided: Set<string>;
}

/** Where fs keeps a hosted system's folders in a rep (`<rep>/dev-systems/fs*` `/data/hosted/<system>`). */
export function hostedFolders(repFolder: string, system: string): string[] {
  const systems = join(repFolder, 'dev-systems');
  if (!existsSync(systems)) { return []; }
  return readdirSync(systems).filter((name) => name === 'fs' || name.startsWith('fs-')).map((name) => join(systems, name, 'data', 'hosted', system)).filter((path) => existsSync(path));
}

/** The files under a system's hosted instance folders' `data` and `state` (not its bundles): what it has kept. */
export function keptFiles(repFolder: string, system: string): number {
  let count = 0;
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) { walk(path); } else { count++; }
    }
  };
  for (const hosted of hostedFolders(repFolder, system)) {
    for (const instance of readdirSync(hosted).filter((name) => name !== 'versions')) {
      for (const part of ['data', 'state']) {
        const path = join(hosted, instance, part);
        if (existsSync(path) && statSync(path).isDirectory()) { walk(path); }
      }
    }
  }
  return count;
}

/** What the watch needs. */
export interface SystemWatchOptions {
  /** The case's person (an admin): goes live and approves reviews as the admin would on the review page. */
  readonly client: SignedIn;
  /** The systems the rep had when the case started: every other one is the case's. */
  readonly baseline: ReadonlySet<string>;
  readonly expect: AuthoringExpectation;
  /** The rep's folder (for the hosted data folders) and the stack's address (for the page's client build). */
  readonly repFolder: string;
  readonly url: string;
  /** How often to look, in ms. */
  readonly every?: number;
  /** The case's hub model cost so far, and the cap past which `onCap` is called once. */
  readonly cost?: () => Promise<number>;
  readonly costCap?: number;
  readonly onCap?: (cost: number) => void;
  readonly log: (line: string) => void;
}

/** Watches the systems a case installs while it plays, and does the admin's review step for them. */
export class SystemWatch {
  readonly #options: SystemWatchOptions;
  readonly #seen = new Map<string, Watched>();
  readonly #errors: string[] = [];
  #live = true;
  #loop: Promise<void> | undefined;
  #capped = false;
  #lastCost = 0;

  constructor(options: SystemWatchOptions) {
    this.#options = options;
  }

  start(): void {
    this.#loop = (async () => {
      let ticks = 0;
      while (this.#live) {
        await this.tick().catch((error: unknown) => { this.#error(`watching: ${message(error)}`); });
        // the cost every 10th look: it pages the hub's model calls
        if (ticks++ % 10 === 0) { await this.#checkCost().catch((error: unknown) => { this.#error(`cost: ${message(error)}`); }); }
        await new Promise((done) => setTimeout(done, this.#options.every ?? 3_000));
      }
    })();
  }

  /** One look: every system not in the baseline, noted, gone live with, its pending review approved. */
  async tick(): Promise<void> {
    const { client } = this.#options;
    for (const listed of await client.hub.call('systems', {})) {
      if (this.#options.baseline.has(listed.name) || listed.status === 'removed') { continue; }
      const watched = this.#watched(listed.name);
      watched.status = listed.status;
      watched.stage = listed.stage ?? '';
      if (listed.version !== '' && !watched.versions.includes(listed.version)) { watched.versions.push(listed.version); }
      const view = await client.hub.call('system', { system: listed.name });
      const instances = view.instances.filter((instance) => instance.status !== 'removed');
      watched.instances = instances.length;
      watched.hosted = instances.some((instance) => instance.host !== undefined);
      watched.hubInstalled = instances.some((instance) => instance.installed !== undefined);
      for (const instance of instances) { if (instance.keyFingerprint !== '') { watched.keys.add(`${instance.instance}:${instance.keyFingerprint}`); } }
      const version = listed.version;
      if (listed.status === 'connected') {
        const review = await client.hub.call('systemReview', { system: listed.name });
        if (listed.stage === 'installed' && !watched.decided.has(`live:${review.manifest.hash}`)) {
          await client.hub.call('goLive', { system: listed.name, hash: review.manifest.hash, off: [] });
          watched.decided.add(`live:${review.manifest.hash}`);
          this.#event(watched, `went live with ${listed.name} ${version}, as the admin on its review page`);
        } else if (review.pending !== undefined && !watched.decided.has(`review:${review.pending.hash}`)) {
          await client.hub.call('approveReview', { system: listed.name, hash: review.pending.hash, off: [] });
          watched.decided.add(`review:${review.pending.hash}`);
          this.#event(watched, `approved ${listed.name}'s pending review (${review.pending.version}: ${review.pending.changes.map((change) => change.name).join(', ').slice(0, 200) || 'no listed changes'}), as the admin on its review page`);
        }
      }
      const sets = await client.hub.call('dataSets', { system: SystemName.parse(listed.name), limit: 100 }).catch(() => undefined);
      const records = sets?.items.reduce((sum, set) => sum + set.records, 0) ?? 0;
      watched.records.set(version, Math.max(watched.records.get(version) ?? 0, records));
      watched.files.set(version, Math.max(watched.files.get(version) ?? 0, keptFiles(this.#options.repFolder, listed.name)));
    }
  }

  /** Stop watching and read every new system once more: its fns, its pages and whether its client build answers. */
  async finish(): Promise<SystemsSeen> {
    this.#live = false;
    await this.#loop;
    await this.tick().catch((error: unknown) => { this.#error(`the last look: ${message(error)}`); });
    const { client, url } = this.#options;
    const pages = await client.hub.call('systemPages', {}).catch((error: unknown) => { this.#error(`pages: ${message(error)}`); return []; });
    const systems: SeenSystem[] = [];
    for (const watched of this.#seen.values()) {
      const rows = await client.hub.call('query', { list: 'fns', query: { filters: [{ field: 'system', op: 'is', value: watched.name }], limit: 100 } }).catch(() => undefined);
      const fns = (rows?.items ?? []).flatMap((row) => (typeof row === 'object' && row !== null && !Array.isArray(row) && typeof row['name'] === 'string' ? [row['name']] : []));
      const own = pages.filter((page) => page.system === watched.name);
      let served = false;
      for (const page of own) {
        const answered = await fetch(new URL(page.client.url, url), { signal: AbortSignal.timeout(10_000) }).then((response) => response.ok, () => false);
        served ||= answered;
      }
      systems.push({
        name: watched.name, status: watched.status, stage: watched.stage, versions: watched.versions, instances: watched.instances, keys: watched.keys.size,
        hosted: watched.hosted, hubInstalled: watched.hubInstalled, fns, pages: own.map((page) => page.segment), pageServed: served,
        recordsByVersion: Object.fromEntries(watched.records), filesByVersion: Object.fromEntries(watched.files), events: watched.events,
      });
    }
    return { expect: this.#options.expect, systems, errors: this.#errors };
  }

  async #checkCost(): Promise<void> {
    const { cost, costCap, onCap } = this.#options;
    if (cost === undefined || costCap === undefined || this.#capped) { return; }
    this.#lastCost = await cost();
    if (this.#lastCost > costCap) {
      this.#capped = true;
      this.#options.log(`the case's model cost reached $${this.#lastCost.toFixed(2)}, past its cap of $${costCap.toFixed(2)}`);
      onCap?.(this.#lastCost);
    }
  }

  #watched(name: string): Watched {
    let watched = this.#seen.get(name);
    if (watched === undefined) {
      watched = { name, status: '', stage: '', versions: [], keys: new Set(), instances: 0, hosted: false, hubInstalled: false, records: new Map(), files: new Map(), events: [], decided: new Set() };
      this.#seen.set(name, watched);
      this.#options.log(`a new system appeared: ${name}`);
    }
    return watched;
  }

  #event(watched: Watched, text: string): void {
    watched.events.push(text);
    this.#options.log(text);
  }

  #error(text: string): void {
    if (!this.#errors.includes(text)) { this.#errors.push(text.slice(0, 400)); }
  }
}

/** The names of the systems the hub has now (not removed). */
export async function systemNames(client: SignedIn): Promise<Set<string>> {
  return new Set((await client.hub.call('systems', {})).filter((system) => system.status !== 'removed').map((system) => system.name));
}

const STOP = QualifiedName.parse('fs/stop_system');

/** Run fs/stop_system with remove for one system as the admin, answering its confirm (and any approval) yes. */
async function stopAndRemove(admin: SignedIn, session: SessionId, system: string, timeout: number): Promise<string> {
  const watch = new SessionWatch(admin, session);
  try {
    const { run } = await admin.hub.call('invoke', { session, fn: STOP, args: { system, remove: true }, client: clientInfo() });
    const answered = new Set<string>();
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      for (const { call } of watch.of('handler')) {
        if (call.status === 'pending' && !answered.has(call.id)) { answered.add(call.id); await admin.hub.call('answer', { call: call.id, value: true }); }
      }
      for (const { approval } of watch.of('approval')) {
        if (approval.status === 'pending' && !answered.has(approval.id)) { answered.add(approval.id); await admin.hub.call('approve', { approval: approval.id, approve: true, remember: 'once' }); }
      }
      const got = await admin.hub.call('run', { run });
      if (isSettled(got.status)) { return got.status; }
      await new Promise((done) => setTimeout(done, 500));
    }
    return 'timed out';
  } finally {
    watch.stop();
  }
}

/**
 * Remove every system the hub has that isn't in `keep`: stopped and its hosted folders deleted by fs (when fs hosts
 * it), removed from the hub, and its folder in the workspace deleted. Never throws; says what it did.
 */
export async function removeInstalled(admin: SignedIn, keep: ReadonlySet<string>, workspace: string | undefined, log: (line: string) => void): Promise<string[]> {
  const done: string[] = [];
  let session: SessionId | undefined;
  for (const system of await admin.hub.call('systems', {}).catch(() => [])) {
    if (keep.has(system.name) || system.status === 'removed') { continue; }
    try {
      session ??= (await admin.hub.call('createSession', { title: 'scenario clean-up' })).id;
      const view = await admin.hub.call('system', { system: system.name });
      const hosted = view.instances.some((instance) => instance.host !== undefined && instance.status !== 'removed');
      // one fs hosts is stopped and its folders deleted by fs; one the hub installed (hub/install_system) by the hub
      const stopped = hosted ? await stopAndRemove(admin, session, system.name, 60_000)
        : await admin.hub.call('stopSystem', { system: system.name }).then(() => 'stopped by the hub', (error: unknown) => `not stopped: ${message(error)}`);
      await admin.hub.call('removeSystem', { system: system.name });
      done.push(`${system.name} (${stopped})`);
    } catch (error) {
      log(`couldn't remove ${system.name}: ${message(error)}`);
    }
  }
  if (workspace !== undefined) {
    const systems = join(workspace, 'systems');
    for (const name of existsSync(systems) ? readdirSync(systems) : []) {
      if (name === 'template') { continue; }
      // a process that ran from it may still hold a handle for a moment (EBUSY on Windows): tried a few times, never thrown
      try {
        rmSync(join(systems, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
        done.push(`folder systems/${name}`);
      } catch (error) {
        log(`couldn't delete the workspace folder systems/${name}: ${message(error)}`);
      }
    }
  }
  return done;
}

/** Kill any hosted process a rep's fs left running its bundle (`process.json` beside its `host.json`); says which. */
export function killLeftovers(repFolder: string): number[] {
  const killed: number[] = [];
  const systems = join(repFolder, 'dev-systems');
  if (!existsSync(systems)) { return killed; }
  const records: string[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (name === 'process.json') { records.push(path); } else if (depth < 6 && name !== 'versions' && statSync(path).isDirectory()) { walk(path, depth + 1); }
    }
  };
  for (const name of readdirSync(systems).filter((n) => n === 'fs' || n.startsWith('fs-'))) {
    const hosted = join(systems, name, 'data', 'hosted');
    if (existsSync(hosted)) { walk(hosted, 0); }
  }
  for (const record of records) {
    try {
      const { pid, entry } = HostedProcess.parse(JSON.parse(readFileSync(record, 'utf8')));
      const line = process.platform === 'win32'
        ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`], { encoding: 'utf8', timeout: 15_000 }).trim()
        : execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 15_000 }).trim();
      // a pid can be reused: only a process running this bundle is ours
      if (line === '' || !line.includes(entry)) { continue; }
      if (process.platform === 'win32') { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15_000 }); } else { process.kill(pid); }
      killed.push(pid);
    } catch {
      // gone already, or unreadable: nothing to kill
    }
  }
  return killed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
