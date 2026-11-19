/**
 * Hosting: systems written on this machine, installed from the chat (`install_system`), run here from a bundle an
 * admin approved, and supervised (`system_status`, `restart_system`, `stop_system`).
 *
 * - **Preview** (before the card): read `system.json`, refuse reserved names, build (typecheck with the folder's own
 *   `tsconfig.json`, bundle one self-contained file, check the contract's name, scan) into a version folder, and
 *   answer the card: what it adds, the change from the running version, the scan and the hashes, with the install
 *   subject the hub binds the pairing grant to. A failed build is refused with its `file:line:col` lines, so the run
 *   is invalid input and the model fixes them without an admin being asked. Whether the name is paired somewhere else
 *   is the hub's to say (only it sees its instances): it refuses the card, or writes what it replaces on it.
 * - **Install** (approved): hash the folder again (a change after the card is invalid input), get a one-time pairing
 *   token bound to the approved subject (none for a system already hosted here: it keeps its key), start the bundle
 *   under the runner with its own folders and wait for it to say it connected. An exit before that is invalid input
 *   with the exit code and the end of its output.
 * - **Folders**: `<dataDir>/hosted/<system>/<instance>/{state,data,cache}` and bundles in
 *   `<dataDir>/hosted/<system>/versions/<bundleHash>/`, the same layout the hub's supervisor uses. What is hosted
 *   (`host.json` beside the instance's folders) is the supervisor's own bookkeeping: which bundle to start, and whether.
 *   The pid of each spawn is kept beside it (`process.json`, `stale.ts`), so when fs starts after a crash the process
 *   it left running is killed before the system starts again. Writes to one instance's files go one at a time, and
 *   renames are tried again while Windows still holds a handle in the folder.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { InstanceName, MAIN_INSTANCE, Manifest, PACKAGE_MANIFEST_FILE, ScanReport, SystemGrants, SystemName, SystemPackageManifest, type ApprovalPreview, type FileGrant, type InstallChecks, type SystemTestReport, type InstallSubject, type InstanceRef, type PairingGrant, type PreviewPart } from '@harness/core';
import { z } from 'zod';
import type { HostedStatusValue, HostedStateValue, InstallResultValue } from '../shared/hosting.ts';
import { HostedProcess, killStale, type ProcessProbe } from './stale.ts';

/** Names a hosted system may never take. */
const RESERVED = new Set(['hub']);

/** What a build of a system folder gives: what will run, and what the card shows. Kept beside its bundle (`built.json`). */
export const BuiltSystem = z.object({
  /** `system.json` as built. */
  manifest: SystemPackageManifest,
  /** The hash of the contract the bundle declares, which its hello must carry. */
  manifestHash: z.string().min(1),
  /** What the contract declares it may do (`Manifest.grants`): its files and network are enforced on this machine. */
  grants: SystemGrants.optional(),
  /**
   * The contract it declares (with its built client, hashed as `manifestHash`), sent with the install card so the hub
   * says what it changes over the version it has. Absent from builds kept before it was.
   */
  contract: Manifest.optional(),
  /** sha-256 of the self-contained server bundle. */
  bundleHash: z.string().min(1),
  /** The bundle's server file, under the build folder. */
  entry: z.string().min(1),
  /** Its fns by qualified name, with their mode and tags (`random/random (read)`), for the card and the diff. */
  fns: z.array(z.string()),
  /** What else it adds (kinds, hooks, mentions, providers, config, renderers), a line each. */
  adds: z.array(z.string()),
  /** What the scan of the server bundle found (`scanLines` words it for the card). */
  scan: ScanReport,
});
export type BuiltSystem = z.infer<typeof BuiltSystem>;

/** Builds and checks system folders (`@harness/build`). An interface so tests use a fake. */
export interface SystemBuilds {
  /** sha-256 over a folder's source files, so a change after approval is caught. */
  sourceHash(dir: string): Promise<string>;
  /** sha-256 of a built bundle file, so only the approved bundle ever starts. */
  bundleHash(file: string): Promise<string>;
  /** Typecheck, bundle into `outDir`, check names and scan; the problems as `file:line:col message` lines when it doesn't build. */
  build(dir: string, outDir: string, signal: AbortSignal): Promise<{ readonly problems: readonly string[] } | { readonly built: BuiltSystem }>;
}

/**
 * Runs a system folder's own tests (the SDK test kit, `harness test`) before its install card is shown. The runner
 * must sandbox them as the build sandboxes the contract (no network, no writes outside a temp folder, no child
 * processes): this is code no admin has approved yet. Undefined when the folder has no tests.
 */
export interface SystemTests {
  run(dir: string, signal: AbortSignal): Promise<SystemTestReport | undefined>;
}

/** The scan report, a line each, for the card: built-ins imported, dynamic code, web hosts, the size. */
export function scanLines(scan: ScanReport): string[] {
  const kb = Math.max(1, Math.round(scan.size / 1024));
  return [
    scan.builtins.length === 0 ? 'Imports no Node built-ins.' : `Node built-ins: ${scan.builtins.join(', ')}.`,
    scan.concerns.length === 0 ? 'No dynamic imports or requires, eval or new Function.' : `${String(scan.concerns.length)} lines of concern (below).`,
    scan.hosts.length === 0 ? 'Names no web hosts.' : `Web hosts it names: ${scan.hosts.join(', ')}.`,
    `Bundle: ${String(kb)} KB.`,
  ];
}

/** `grants.files` as absolute paths: a relative one is under the instance's data folder. */
export function grantedPaths(files: FileGrant | undefined, dataFolder: string): { read: string[]; write: string[] } {
  const paths = (list: readonly string[] | undefined): string[] => (list ?? []).map((path) => (isAbsolute(path) ? resolve(path) : resolve(dataFolder, path)));
  return { read: paths(files?.read), write: paths(files?.write) };
}

/** Whether `path` is `folder` or inside it (letter case ignored on Windows). */
function within(folder: string, path: string): boolean {
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const rel = relative(fold(folder), fold(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Where a review of grants looks. */
export interface GrantPlaces {
  /** The instance's own folders (state, data, cache). */
  readonly own: readonly string[];
  /** Where its relative paths are (its data folder). */
  readonly dataFolder: string;
  /** fs's whole data folder: every hosted system's bundles, keys and records. */
  readonly fsData: string;
  readonly home: string;
}

/** A granted path as a card item, with what is notable about it, and whether it is never granted. */
function pathItem(path: string, places: GrantPlaces): { text: string; never: boolean } {
  const root = dirname(path) === path;
  const notes = [
    ...(places.own.some((folder) => within(folder, path)) ? [] : ['outside its own folders']),
    // a whole drive, the home folder or a folder holding it, or a folder at the top of a drive
    ...(root || within(path, places.home) || dirname(dirname(path)) === dirname(path) ? ['BROAD'] : []),
  ];
  return { text: notes.length === 0 ? `\`${path}\`` : `\`${path}\` (${notes.join(', ')})`, never: root || within(path, places.fsData) };
}

/**
 * The grants a contract declares, as card lines: they are enforced from the moment the system starts (files and
 * network on this machine, the rest by the hub), before any review page. A path outside its own folders is marked and
 * a broad one flagged; a filesystem root, or a folder holding fs's data, is never granted (`refused` says so).
 */
export function grantsReview(grants: SystemGrants | undefined, places: GrantPlaces): { lines: string[]; refused?: string } {
  const files = grantedPaths(grants?.files, places.dataFolder);
  const reads = files.read.map((path) => pathItem(path, places));
  const writes = files.write.map((path) => pathItem(path, places));
  const list = (label: string, items: readonly string[]): string[] => (items.length === 0 ? [] : [`- ${label}: ${items.join(', ')}`]);
  const models = grants?.models;
  const network = grants?.network ?? [];
  const hub = grants?.hub ?? [];
  const lines = [
    'Grants, enforced from the moment it starts:',
    ...list('Reads', reads.map((item) => item.text)),
    ...list('Writes', writes.map((item) => item.text)),
    `- Network: ${network.length === 0 ? 'no hosts' : network.join(', ')}`,
    `- Hub: ${hub.length === 0 ? 'the base only' : hub.join(', ')}`,
    ...list('Models', models === undefined ? [] : [
      models.roles === undefined ? 'any role' : `roles ${models.roles.join(', ')}`,
      ...(models.models === undefined ? [] : [`models ${models.models.join(', ')}`]),
      ...(models.perRun === undefined ? [] : [`up to $${String(models.perRun)} a run`]),
      ...(models.perDay === undefined ? [] : [`$${String(models.perDay)} a day`]),
    ]),
    ...list('Secrets', grants?.secrets ?? []),
    ...list('Calls', grants?.calls ?? []),
  ];
  const never = [...reads, ...writes].filter((item) => item.never).map((item) => item.text);
  if (never.length === 0) { return { lines }; }
  return { lines, refused: `Its grants.files name ${never.join(', ')}: a filesystem root, or a folder holding fs's data (every hosted system's code and keys), is never granted. Name only the folders it needs.` };
}

/** What the runner starts: a bundle under tsx, in its folders, with only the environment given. */
export interface HostedLaunch {
  /** The instance it runs, for the refusals reported to the hub. */
  readonly ref: InstanceRef;
  readonly entry: string;
  /** Where it runs: its bundle folder, which it may read. */
  readonly cwd: string;
  /** The folders it may write: its state, data and cache. */
  readonly writes: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly permissions: SystemPackageManifest['permissions'];
  /** `grants.files`, as absolute paths: what it may read and write beyond its own folders. */
  readonly files: { readonly read: readonly string[]; readonly write: readonly string[] };
  /** `grants.network`: the hosts its allowlist proxy lets through (none declared, none). */
  readonly network: readonly string[];
  /** Told the pid of every process started for it (the first and each restart), so a later fs can find it. */
  readonly spawned: (pid: number) => void;
}

/** How a start went: it said it connected (or waits for config), it exited first, or it said nothing in time. */
export type StartOutcome =
  | { readonly state: 'connected' | 'needs-config' }
  | { readonly exited: { readonly code: number | null; readonly output: string } }
  | { readonly timedOut: { readonly output: string } };

/** How starting a hosted system went: as the runner saw it, or refused before it ran (its bundle isn't the approved one). */
export type HostedStart = StartOutcome | { readonly refused: string };

/** A hosted process as the runner sees it. */
export interface RunnerStatus {
  readonly state: HostedStateValue;
  readonly pid?: number;
  readonly restartsLastHour: number;
  readonly output: string;
}

/** Starts, watches and stops hosted processes under the shared supervision policy (backoff, a cap per hour). */
export interface HostedRunner {
  /** Start (or restart) one; resolves once it says it connected or needs config, exits, or `timeout` passes. */
  start(key: string, launch: HostedLaunch, timeout: number): Promise<StartOutcome>;
  stop(key: string): Promise<void>;
  status(key: string): RunnerStatus | undefined;
}

/** A one-time pairing token bound to an approved install run's subject (`grantPairing` on the link). */
export type GrantPairing = (subject: InstallSubject) => Promise<PairingGrant>;

/** What hosting is built from. */
export interface HostingDeps {
  readonly builds: SystemBuilds;
  /** Runs the folder's tests for the card; without it the card carries the scan only. */
  readonly tests?: SystemTests;
  readonly runner: HostedRunner;
  /** Finds and kills a hosted process an earlier fs left running. */
  readonly probe: ProcessProbe;
  /** The hub's link URL, for the hosted processes. */
  readonly hubUrl: string;
  /** This fs instance, the host. */
  readonly host: InstanceRef;
  /** fs's data folder; hosted folders go under `hosted/`. */
  readonly dataDir: string;
  readonly limits: {
    /** How long a start may take to connect. */
    readonly connectTimeout: number;
    /** The most problem lines an invalid build returns. */
    readonly problems: number;
    /** Characters of output kept for a crash. */
    readonly outputTail: number;
    /** Tries of a rename Windows refuses while a handle is still open in it (EPERM, EBUSY, EACCES). */
    readonly renameTries: number;
    /** The first wait between those tries, doubling each time. */
    readonly renameWait: number;
  };
  /** Told of a stale hosted process found (and killed or not) or a lookup that failed, when fs starts. */
  readonly onStale?: (key: string, outcome: { killed: boolean; pid: number } | { failed: string }) => void;
}

/** What is hosted, kept beside the instance's folders. */
export const HostedRecord = z.object({
  system: SystemName,
  instance: InstanceName,
  version: z.string().min(1),
  /** The source folder it was built from. */
  folder: z.string().min(1),
  bundleHash: z.string().min(1),
  manifestHash: z.string().min(1),
  /** The bundle's server file. */
  entry: z.string().min(1),
  fns: z.array(z.string()),
  permissions: SystemPackageManifest.shape.permissions,
  /** What its approved contract declares it may do; absent on records from before build 7, which get no more than their own folders. */
  grants: SystemGrants.optional(),
  /** Whether fs starts it when it starts (false once stopped). */
  start: z.boolean(),
});
export type HostedRecord = z.infer<typeof HostedRecord>;

/** Why an install can't go ahead, said to the model as invalid input. */
export class InstallRefused extends Error {}

/** Lines, cut to the most the model is given, with how many more there were. */
export function capped(lines: readonly string[], max: number): string {
  const shown = lines.slice(0, max);
  return [...shown, ...(lines.length > max ? [`and ${String(lines.length - max)} more`] : [])].join('\n');
}

/** The end of a text, at most `max` characters. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** A fn's name from its line on a card (`random/roll (read; tags: dice)`). */
function fnName(line: string): string {
  return line.split(' ')[0] ?? line;
}

/** The fns lines of the diff between two versions, in words (a leading `+` or `-` would read as a nested list): added, removed and changed, by name. */
export function fnsDiff(before: readonly string[], after: readonly string[]): string[] {
  const nameOf = fnName;
  const had = new Map(before.map((line) => [nameOf(line), line]));
  const has = new Map(after.map((line) => [nameOf(line), line]));
  return [
    ...after.filter((line) => !had.has(nameOf(line))).map((line) => `adds ${line}`),
    ...before.filter((line) => !has.has(nameOf(line))).map((line) => `removes ${line}`),
    ...after.filter((line) => had.has(nameOf(line)) && had.get(nameOf(line)) !== line).map((line) => `changes ${line} (was ${had.get(nameOf(line)) ?? ''})`),
  ];
}

/** The systems this fs instance hosts. */
export class Hosting {
  readonly #deps: HostingDeps;
  /** The preview or install under way for each system, so two never build, start, write or prune its versions at once. */
  readonly #installing = new Map<string, Promise<unknown>>();
  /** The last write to each instance's files, so two never race on one file. */
  readonly #writes = new Map<string, Promise<void>>();

  constructor(deps: HostingDeps) {
    this.#deps = deps;
  }

  /** The root of the hosted folders. */
  get root(): string {
    return join(this.#deps.dataDir, 'hosted');
  }

  /** An instance's folders, as the hub's supervisor lays them out. */
  folders(system: string, instance: string): { state: string; data: string; cache: string; record: string; process: string } {
    const at = join(this.root, system, instance);
    return { state: join(at, 'state'), data: join(at, 'data'), cache: join(at, 'cache'), record: join(at, 'host.json'), process: join(at, 'process.json') };
  }

  /** Where a version's bundle is built. */
  versionFolder(system: string, bundleHash: string): string {
    return join(this.root, system, 'versions', bundleHash);
  }

  /**
   * The card for installing a folder, or why not (`InstallRefused`). The bundle is built into its version folder
   * here, so the run starts exactly what the admin saw.
   */
  async preview(folder: string, options: { instance?: string | undefined }, signal: AbortSignal): Promise<ApprovalPreview> {
    return (await this.card(folder, options, signal)).preview;
  }

  /** The card (`preview`) with the contract it would install, which the hub reads to say what it changes (`PreviewAnswer.contract`). */
  async card(folder: string, options: { instance?: string | undefined }, signal: AbortSignal): Promise<{ preview: ApprovalPreview; contract?: Manifest }> {
    const manifest = await this.#systemJson(folder);
    const instance = this.#instance(options.instance);
    const hosted = await this.record(manifest.name, instance);
    if (RESERVED.has(manifest.name)) { throw new InstallRefused(`"${manifest.name}" is reserved for the hub: rename the system in system.json and its contract.`); }
    const built = await this.#serial(manifest.name, () => this.#build(folder, manifest.name, signal));
    const dirs = this.folders(manifest.name, instance);
    const grants = grantsReview(built.grants, { own: [dirs.state, dirs.data, dirs.cache], dataFolder: dirs.data, fsData: this.#deps.dataDir, home: homedir() });
    if (grants.refused !== undefined) { throw new InstallRefused(grants.refused); }
    const sourceHash = await this.#deps.builds.sourceHash(folder);
    // the folder's own tests run before an admin is asked, and their result goes on the card beside the scan
    const tests = await this.#deps.tests?.run(folder, signal);
    const checks: InstallChecks = { scan: built.scan, ...(tests === undefined ? {} : { tests }) };
    const subject: InstallSubject = {
      kind: 'system-install',
      system: manifest.name,
      instance,
      version: manifest.version,
      manifestHash: built.manifestHash,
      bundleHash: built.bundleHash,
      sourceHash,
      host: this.#deps.host,
      source: folder,
      ...(built.grants === undefined ? {} : { grants: built.grants }),
      ...(hosted === undefined ? {} : { replaces: { version: hosted.version, manifestHash: hosted.manifestHash } }),
    };
    const where = `${this.#deps.host.system}/${this.#deps.host.instance}`;
    const title = hosted === undefined
      ? `Install ${manifest.name} ${manifest.version} on ${where}`
      : `Update ${manifest.name} ${hosted.version} → ${manifest.version} on ${where}`;
    const diff = hosted === undefined ? [] : fnsDiff(hosted.fns, built.fns);
    const permissions = Object.entries(built.manifest.permissions ?? {}).filter(([, on]) => on === true).map(([name]) => name);
    // the title names the system and its versions, and the subject card under the scan binds the hashes and the host:
    // the words say only what those don't, and a fn the diff lists isn't listed again
    const changed = new Set(diff.map((line) => fnName(line.slice(2))));
    const kept = built.fns.filter((line) => !changed.has(fnName(line)));
    const parts: PreviewPart[] = [
      {
        type: 'text',
        text: [
          `${manifest.description} Built from \`${folder}\`.`,
          ...(kept.length === 0 ? [] : ['', hosted === undefined ? 'Fns:' : 'Fns it keeps:', ...kept.map((line) => `- ${line}`)]),
          ...(built.adds.length === 0 ? [] : ['', 'Also adds:', ...built.adds.map((line) => `- ${line}`)]),
          ...(permissions.length === 0 ? [] : ['', `Asks to: ${permissions.join(', ')}.`]),
          '', ...grants.lines,
        ].join('\n'),
      },
      ...(hosted === undefined ? [] : [{ type: 'text' as const, text: ['Changes from the running version:', ...(diff.length === 0 ? ['- no fns added, removed or changed'] : diff.map((line) => `- ${line}`))].join('\n') }]),
      { type: 'text', text: ['Scan (a report, not a guarantee):', ...scanLines(built.scan).map((line) => `- ${line}`)].join('\n') },
      ...built.scan.concerns.map((concern) => ({ type: 'code' as const, language: 'js', code: `${concern.code}  // ${concern.detail}`, title: `Bundle line ${String(concern.line)}` })),
    ];
    return { preview: { title, parts, irreversible: false, subject, checks }, ...(built.contract === undefined ? {} : { contract: built.contract }) };
  }

  /** Start what an admin approved; see the file's docs. Installs of one system wait for each other. */
  async install(folder: string, subject: InstallSubject, grant: GrantPairing, signal: AbortSignal): Promise<InstallResultValue> {
    return await this.#serial(subject.system, () => this.#install(folder, subject, grant, signal));
  }

  /** Run work after the system's earlier preview or install ends, so builds and prunes of its versions never overlap. */
  async #serial<T>(system: string, work: () => Promise<T>): Promise<T> {
    const before = this.#installing.get(system) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(work);
    this.#installing.set(system, mine);
    try {
      return await mine;
    } finally {
      if (this.#installing.get(system) === mine) { this.#installing.delete(system); }
    }
  }

  async #install(folder: string, subject: InstallSubject, grant: GrantPairing, signal: AbortSignal): Promise<InstallResultValue> {
    if (await this.#deps.builds.sourceHash(folder) !== subject.sourceHash) {
      throw new InstallRefused('The folder changed after approval; call install_system again to build and approve the new code.');
    }
    let built = await this.#readBuilt(this.versionFolder(subject.system, subject.bundleHash));
    if (built === undefined) {
      const again = await this.#build(folder, subject.system, signal);
      if (again.bundleHash !== subject.bundleHash) { throw new InstallRefused('The build is not the one approved; call install_system again.'); }
      built = again;
    }
    // it starts with the grants the card showed, or not at all
    if (!isDeepStrictEqual(built.grants, subject.grants)) { throw new InstallRefused('Its grants are not the ones approved; call install_system again.'); }
    const hosted = await this.record(subject.system, subject.instance);
    // what it may do comes from the approved build, never from system.json read again
    // a system already hosted here keeps its key and re-pairs by itself; a new one needs a token bound to this approval
    const token = hosted === undefined ? (await grant(subject)).token : undefined;
    const record: HostedRecord = {
      system: subject.system, instance: subject.instance, version: subject.version, folder, bundleHash: subject.bundleHash,
      manifestHash: subject.manifestHash, entry: built.entry, fns: [...built.fns], permissions: built.manifest.permissions, ...(built.grants === undefined ? {} : { grants: built.grants }), start: true,
    };
    const outcome = await this.#start(record, token);
    if (!('state' in outcome)) {
      // the old version keeps its record, so restart_system brings it back
      if (hosted !== undefined) { await this.#start(hosted, undefined); }
      throw new InstallRefused(this.#why(outcome));
    }
    await this.#write(record);
    await this.#prune(subject.system, subject.bundleHash);
    return { system: record.system, instance: record.instance, version: record.version, status: outcome.state, fns: built.fns.map((line) => line.split(' ')[0] ?? line), folder };
  }

  /** The hosted systems (or one), as the runner sees them now. */
  async status(system?: string): Promise<HostedStatusValue[]> {
    const records = (await this.records()).filter((record) => system === undefined || record.system === system);
    return records.map((record) => {
      const seen = this.#deps.runner.status(keyOf(record));
      return {
        system: record.system, instance: record.instance, version: record.version,
        state: seen?.state ?? (record.start ? 'crashed' : 'stopped'),
        ...(seen?.pid === undefined ? {} : { pid: seen.pid }),
        restartsLastHour: seen?.restartsLastHour ?? 0,
        folder: record.folder, bundleHash: record.bundleHash, output: seen?.output ?? '',
      };
    });
  }

  /** Restart a hosted system with its approved bundle. */
  async restart(system: string, instance: string | undefined): Promise<HostedStateValue> {
    const record = await this.#hosted(system, instance);
    const outcome = await this.#start(record, undefined);
    if (!('state' in outcome)) { throw new InstallRefused(this.#why(outcome)); }
    await this.#write({ ...record, start: true });
    return outcome.state;
  }

  /** Stop a hosted system (it stays stopped); with `remove`, delete its folders too. */
  async stop(system: string, instance: string | undefined, remove: boolean): Promise<{ stopped: boolean; removed: boolean }> {
    const record = await this.#hosted(system, instance);
    await this.#deps.runner.stop(keyOf(record));
    if (!remove) {
      await this.#write({ ...record, start: false });
      return { stopped: true, removed: false };
    }
    await rm(join(this.root, record.system, record.instance), { recursive: true, force: true });
    const others = (await this.records()).filter((other) => other.system === record.system);
    // the bundles go with the last instance of the system
    if (others.length === 0) { await rm(join(this.root, record.system), { recursive: true, force: true }); }
    return { stopped: true, removed: true };
  }

  /** The folders `stop` with `remove` deletes. */
  async removes(system: string, instance: string | undefined): Promise<string[]> {
    const record = await this.#hosted(system, instance);
    return [join(this.root, record.system, record.instance)];
  }

  /** Start every hosted system marked to start (when fs starts). Each start is logged by the caller; failures are kept in its status. */
  async startAll(): Promise<{ system: string; outcome: HostedStart }[]> {
    const records = await this.records();
    // a process an fs that crashed left running goes first, or the system would run twice
    await Promise.all(records.map((record) => this.#reap(record)));
    const marked = records.filter((record) => record.start);
    return await Promise.all(marked.map(async (record) => ({ system: `${record.system}/${record.instance}`, outcome: await this.#start(record, undefined) })));
  }

  /** Stop every hosted system (when fs stops); they start again with fs. */
  async stopAll(): Promise<void> {
    await Promise.all((await this.records()).map((record) => this.#deps.runner.stop(keyOf(record))));
  }

  /** One hosted record, if this fs hosts it. */
  async record(system: string, instance: string): Promise<HostedRecord | undefined> {
    let text: string;
    try {
      text = await readFile(this.folders(system, instance).record, 'utf8');
    } catch (error) {
      if (isMissing(error)) { return undefined; }
      throw error;
    }
    return HostedRecord.parse(JSON.parse(text));
  }

  /** Every hosted record. */
  async records(): Promise<HostedRecord[]> {
    const systems = await names(this.root);
    const found = await Promise.all(systems.map(async (system) => {
      const instances = (await names(join(this.root, system))).filter((name) => name !== 'versions');
      return await Promise.all(instances.map((instance) => this.record(system, instance)));
    }));
    return found.flat().filter((record): record is HostedRecord => record !== undefined);
  }

  async #hosted(system: string, instance: string | undefined): Promise<HostedRecord> {
    const name = this.#instance(instance);
    const record = await this.record(system, name);
    if (record === undefined) {
      const hosted = (await this.records()).map((other) => `${other.system}/${other.instance}`);
      throw new InstallRefused(`${system}/${name} isn't hosted here.${hosted.length === 0 ? ' Nothing is.' : ` Hosted: ${hosted.join(', ')}.`}`);
    }
    return record;
  }

  #instance(instance: string | undefined): InstanceName {
    const parsed = InstanceName.safeParse(instance ?? MAIN_INSTANCE);
    // `versions` is where the bundles are kept
    if (!parsed.success || parsed.data === 'versions') { throw new InstallRefused(`"${instance ?? ''}" isn't an instance name: lowercase letters, digits and dashes.`); }
    return parsed.data;
  }

  async #systemJson(folder: string): Promise<SystemPackageManifest> {
    let text: string;
    try {
      text = await readFile(join(folder, PACKAGE_MANIFEST_FILE), 'utf8');
    } catch (error) {
      if (isMissing(error)) { throw new InstallRefused(`${folder} has no ${PACKAGE_MANIFEST_FILE}: give the system's folder (copy systems/template to start one).`); }
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new InstallRefused(`${PACKAGE_MANIFEST_FILE} isn't JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = SystemPackageManifest.safeParse(json);
    if (!parsed.success) {
      throw new InstallRefused(`${PACKAGE_MANIFEST_FILE} is wrong:\n${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(top)'}: ${issue.message}`).join('\n')}`);
    }
    return parsed.data;
  }

  /**
   * Build into a fresh folder, then move it to its version folder (by bundle hash), keeping the built summary beside
   * it. When that version folder already exists (the same server bundle, maybe running), the build is copied over it
   * in place: a running process's folder is never removed (Windows refuses that, and its restarts need the bundle).
   */
  async #build(folder: string, system: string, signal: AbortSignal): Promise<BuiltSystem> {
    const versions = join(this.root, system, 'versions');
    await mkdir(versions, { recursive: true });
    const scratch = await mkdtemp(join(versions, 'building-'));
    try {
      const answer = await this.#deps.builds.build(folder, scratch, signal);
      if ('problems' in answer) {
        throw new InstallRefused(`It doesn't build. Fix these and call install_system again:\n${capped(answer.problems, this.#deps.limits.problems)}`);
      }
      const target = this.versionFolder(system, answer.built.bundleHash);
      if (await isFolder(target)) {
        await cp(scratch, target, { recursive: true, force: true });
      } else {
        await this.#rename(scratch, target);
      }
      const built: BuiltSystem = { ...answer.built, entry: join(target, relativeTo(scratch, answer.built.entry)) };
      await writeFile(join(target, BUILT_FILE), JSON.stringify(built), 'utf8');
      return built;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async #readBuilt(bundle: string): Promise<BuiltSystem | undefined> {
    try {
      return BuiltSystem.parse(JSON.parse(await readFile(join(bundle, BUILT_FILE), 'utf8')));
    } catch (error) {
      if (isMissing(error)) { return undefined; }
      throw error;
    }
  }

  async #start(record: HostedRecord, token: string | undefined): Promise<HostedStart> {
    const found = await this.#deps.builds.bundleHash(record.entry).catch((error: unknown) => {
      if (isMissing(error)) { return undefined; }
      throw error;
    });
    if (found !== record.bundleHash) {
      return { refused: `The bundle of ${keyOf(record)} at ${record.entry} ${found === undefined ? 'is gone' : 'changed since it was approved'}, so it was not started. Call install_system again to build and approve it.` };
    }
    const dirs = this.folders(record.system, record.instance);
    await Promise.all([dirs.state, dirs.data, dirs.cache].map((dir) => mkdir(dir, { recursive: true })));
    // it runs in its bundle folder (where serve() reads its version); it writes only to its own folders
    const env: Record<string, string> = {
      HARNESS_HUB: this.#deps.hubUrl,
      HARNESS_INSTANCE: record.instance,
      HARNESS_SYSTEM_NAME: record.system,
      HARNESS_SYSTEM_STATE: dirs.state,
      HARNESS_SYSTEM_DATA: dirs.data,
      HARNESS_SYSTEM_CACHE: dirs.cache,
      HARNESS_SUPERVISED: '1',
      // the runner reads the SDK's status lines (JSON, at info) to know it connected
      HARNESS_LOG_JSON: 'true',
      HARNESS_LOG_LEVEL: 'info',
      ...(token === undefined ? {} : { HARNESS_PAIRING_TOKEN: token }),
    };
    // its declared paths, relative to its data folder or absolute
    const files = grantedPaths(record.grants?.files, dirs.data);
    return await this.#deps.runner.start(keyOf(record), {
      ref: { system: record.system, instance: record.instance }, entry: record.entry, cwd: this.versionFolder(record.system, record.bundleHash),
      writes: [dirs.state, dirs.data, dirs.cache], env, permissions: record.permissions, files, network: record.grants?.network ?? [],
      spawned: (pid) => { this.#keep(record, dirs.process, { pid, entry: record.entry }).catch(() => undefined); },
    }, this.#deps.limits.connectTimeout);
  }

  async #write(record: HostedRecord): Promise<void> {
    await this.#keep(record, this.folders(record.system, record.instance).record, record);
  }

  /** Write one of an instance's files whole, after its earlier writes, through a temp file of its own. */
  #keep(owner: Pick<HostedRecord, 'system' | 'instance'>, file: string, value: HostedRecord | HostedProcess): Promise<void> {
    const key = keyOf(owner);
    const write = async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
      await this.#rename(temp, file);
    };
    const next = (this.#writes.get(key) ?? Promise.resolve()).then(write);
    const settled = next.catch(() => undefined);
    this.#writes.set(key, settled);
    void settled.then(() => { if (this.#writes.get(key) === settled) { this.#writes.delete(key); } });
    return next;
  }

  /** Kill the process `process.json` names if it still runs this instance's bundle (an fs that crashed left it). */
  async #reap(record: HostedRecord): Promise<void> {
    const file = this.folders(record.system, record.instance).process;
    let kept: HostedProcess;
    try {
      kept = HostedProcess.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if (!isMissing(error)) { this.#deps.onStale?.(keyOf(record), { failed: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    try {
      const killed = await killStale(this.#deps.probe, kept);
      this.#deps.onStale?.(keyOf(record), { killed, pid: kept.pid });
      await rm(file, { force: true });
    } catch (error) {
      this.#deps.onStale?.(keyOf(record), { failed: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Rename, trying again while Windows refuses because a handle is still open in it. */
  async #rename(from: string, to: string): Promise<void> {
    const { renameTries, renameWait } = this.#deps.limits;
    await renameRetrying(from, to, { tries: renameTries, wait: renameWait });
  }

  /** Remove bundles no instance of the system runs any more. */
  async #prune(system: string, keep: string): Promise<void> {
    const used = new Set([keep, ...(await this.records()).filter((record) => record.system === system).map((record) => record.bundleHash)]);
    const versions = join(this.root, system, 'versions');
    for (const name of await names(versions)) {
      if (!used.has(name)) { await rm(join(versions, name), { recursive: true, force: true }); }
    }
  }

  #why(outcome: Exclude<HostedStart, { state: unknown }>): string {
    if ('refused' in outcome) { return outcome.refused; }
    const max = this.#deps.limits.outputTail;
    if ('exited' in outcome) {
      return `It exited (code ${outcome.exited.code === null ? 'none' : String(outcome.exited.code)}) before it connected. The end of its output:\n${tail(outcome.exited.output, max)}`;
    }
    return `It didn't connect within ${String(Math.round(this.#deps.limits.connectTimeout / 1000))} s, so it was stopped. The end of its output:\n${tail(outcome.timedOut.output, max)}`;
  }
}

/** The file beside a bundle that keeps what its build found, so a run starts what its preview built. */
const BUILT_FILE = 'built.json';

/** A hosted instance's runner key. */
function keyOf(record: Pick<HostedRecord, 'system' | 'instance'>): string {
  return `${record.system}/${record.instance}`;
}

/** A path under `from`, relative to it (the build reports its entry under the scratch folder). */
function relativeTo(from: string, path: string): string {
  const normal = (value: string) => value.replaceAll('\\', '/');
  const base = `${normal(from)}/`;
  return normal(path).startsWith(base) ? normal(path).slice(base.length) : normal(path);
}

/** Whether a folder exists there. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) { return false; }
    throw error;
  }
}

/**
 * Rename, trying again with a doubling wait (`wait`, then twice that, ...) while the rename fails because a handle is
 * still open in it, up to `tries` in all; any other failure, or the last one, is thrown. `move` and `sleep` are seams
 * for tests (a held Windows handle can't be made on demand).
 */
export async function renameRetrying(
  from: string, to: string, limits: { readonly tries: number; readonly wait: number },
  move: (from: string, to: string) => Promise<void> = rename,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => { setTimeout(done, ms); }),
): Promise<void> {
  for (let tried = 1; ; tried += 1) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      if (tried >= limits.tries || !isHeld(error)) { throw error; }
      await sleep(limits.wait * 2 ** (tried - 1));
    }
  }
}

/** Whether a rename failed because something still holds a handle in it (Windows: Defender, the indexer, a child not fully gone). */
function isHeld(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The names of a folder's subfolders (none when it doesn't exist). */
async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) { return []; }
    throw error;
  }
}
