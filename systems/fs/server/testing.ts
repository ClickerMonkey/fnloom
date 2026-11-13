/**
 * Test seams for the fs server: in-memory contexts for fns, actions and system events, a fake shell and fake git, so
 * the implementation runs against a temp folder with no hub. Used by the `*.test.ts` files only.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIN_INSTANCE, RunInfo, UserInfo, mintId, type ApprovedRun, type ChangeSet, type FnError, type Json, type QualifiedName, type TimeInfo } from '@harness/core';
import {
  parseValue, type AttachmentRef, type Callers, type FnCtx, type FnTypes, type HandlersInRun, type Log, type Outcome,
  type ProgressReporter, type SessionState, type SettingRef, type SystemCtx, type UndoCtx,
} from '@harness/sdk';
import { HubLlm, type HubAccess } from '@harness/sdk/server';
import { NO_ASKS, TEST_PLACE } from '@harness/sdk/server/testing';
import type { CaptureSession, ChangeCapture, CommandRun, FsConfig, Git, GitStatus, IgnoreCheck, Opener, Restarter, Shell } from './index.ts';
import { normalize } from './paths.ts';

/** A temp folder for one test, removed by `cleanup`. */
export async function tempFolder(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = normalize(await mkdtemp(join(tmpdir(), 'harness-fs-')));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** A config with one writable root. Plain JSON as well, so a fake hub can hold it. */
export function configFor(folder: string, more: Partial<FsConfig['roots'][number]> = {}): Pick<FsConfig, 'roots'> {
  return { roots: [{ path: folder, name: 'work', writable: true, index: 'all', ...more }] };
}

/** One log line a fake context recorded. */
export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly key: string;
  readonly fields: Record<string, Json> | undefined;
}

/** A log that records what it is given. */
export function recordingLog(): Log & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (key: string, fields?: Record<string, Json>) => { lines.push({ level, key, fields }); };
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** In-memory session state. */
export function memoryState<S extends object>(initial: Partial<S> = {}): SessionState<S> & { readonly value: () => Partial<S> } {
  let value: Partial<S> = { ...initial };
  return {
    value: () => value,
    get: () => Promise.resolve(value),
    set: (patch) => { value = { ...value, ...patch }; return Promise.resolve(); },
    update: (change) => { value = { ...value, ...change(value) }; return Promise.resolve(); },
    clear: (...fields) => {
      const next = { ...value };
      for (const field of fields) { Reflect.deleteProperty(next, field); }
      value = next;
      return Promise.resolve();
    },
  };
}

const user = UserInfo.parse({ id: mintId('actor'), name: 'Ada', email: 'ada@example.com', role: 'admin', groups: [], timeZone: 'UTC', locale: 'en-US' });
const time: TimeInfo = { now: 0, timeZone: 'UTC', local: '1970-01-01T00:00:00+00:00' };
const unused = (what: string) => () => Promise.reject(new Error(`${what} isn't used by the fs system`));

/** A hub that is never reached, so the real `HubLlm` over it fails every call: the fs system uses no LLM. */
const unreachable: HubAccess = {
  ready: unused('llm'),
  now: () => undefined,
  limits: () => ({ maxFrame: 262_144, maxChunk: 131_072, heartbeat: 15_000 }),
};

/** What a fake context recorded. */
export interface Recorded {
  readonly attachments: Array<{ name: string; data: unknown; title: string }>;
  readonly log: ReturnType<typeof recordingLog>;
}

/** Options every fake context takes. */
export interface FakeOptions {
  readonly config: FsConfig;
  /** Actor settings by qualified name, as JSON; checked against the setting's type when read. */
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** The approval the run went ahead on (`ctx.approved`), for fns with `approval`. */
  readonly approved?: ApprovedRun;
}

/** The services every fake run, undo and action gets. */
function services(options: FakeOptions, recorded: Recorded) {
  return {
    ...TEST_PLACE,
    llm: new HubLlm({ hub: unreachable }),
    ai: unused('ai'),
    notifyAdmins: unused('notifyAdmins'),
    files: { read: unused('files'), readText: unused('files'), write: unused('files'), list: unused('files'), remove: unused('files'), share: unused('files') },
    fetch: unused('fetch'),
    resources: { stat: unused('resources'), text: unused('resources'), links: unused('resources'), sections: unused('resources'), search: unused('resources') },
    types: { definitions: unused('types') },
    data: { find: unused('data'), get: unused('data'), table: unused('data'), save: unused('data'), remove: unused('data') },
    attach: <A>(ref: AttachmentRef<QualifiedName, A>, data: A, title: string) => { recorded.attachments.push({ name: ref.name, data: parseValue(ref.data, data), title }); },
    link: () => undefined,
    setting: <V>(ref: SettingRef<QualifiedName, V>) => {
      const raw = options.settings?.[ref.name];
      return Promise.resolve(raw === undefined ? undefined : parseValue(ref.type, raw));
    },
    log: recorded.log,
  };
}

function record(): Recorded {
  return { attachments: [], log: recordingLog() };
}

/** The parts of a run context that depend on the fn's own declarations. */
export interface FnParts<T extends FnTypes> {
  readonly handlers: HandlersInRun<T['handlers']>;
  readonly progress: ProgressReporter<T['progress']>;
  readonly fns: Callers<T['deps']>;
  readonly form: FnCtx<T, FsConfig>['form'];
  readonly state: SessionState<T['state']>;
}

function runInfo(): RunInfo {
  return RunInfo.parse({
    id: mintId('run'), fn: 'fs/test', turn: mintId('turn'), user, time,
    system: { name: 'fs', instance: MAIN_INSTANCE, boot: 'test' }, caller: user.id, attempt: 1, priority: 'interactive',
  });
}

/** A run context for a fn, with what it attached and logged. */
export function fnCtx<T extends FnTypes>(parts: FnParts<T>, options: FakeOptions): { ctx: FnCtx<T, FsConfig> } & Recorded {
  const recorded = record();
  const run = runInfo();
  const ctx: FnCtx<T, FsConfig> = {
    ...services(options, recorded),
    ...NO_ASKS,
    ...parts,
    config: options.config,
    run,
    budget: { remaining: () => ({ cost: 1, time: 60_000 }), limitedBy: () => 'session', spend: () => undefined },
    signal: options.signal ?? new AbortController().signal,
    resume: undefined,
    connection: undefined,
    approved: options.approved,
    updateConnection: () => Promise.reject(new Error('This run acts as no connection.')),
    shareFn: () => Promise.resolve(),
    usableFns: (fns) => Promise.resolve([...fns]),
    onPause: () => undefined,
    allow: () => undefined,
    undoWith: () => undefined,
    expose: () => undefined,
    done: (result, extra) => ({ status: 'done', result, ...extra }),
    invalid: (problems) => ({ status: 'invalid-input', invalid: { source: 'validation', problems: typeof problems === 'string' ? [{ path: '', message: problems }] : [...problems] } }),
    fail: (cls, message, extra) => {
      const error: FnError = { class: cls, message, ...(extra?.code === undefined ? {} : { code: extra.code }), ...(extra?.data === undefined ? {} : { data: extra.data }) };
      return { status: 'failed', error, ...(extra?.undo === undefined ? {} : { undo: extra.undo }) };
    },
    pause: (resume) => ({ status: 'paused', resume }),
    cancelled: (extra) => ({ status: 'cancelled', ...extra }),
  };
  return { ctx, ...recorded };
}

/** An undo context. */
export function undoCtx(options: FakeOptions): { ctx: UndoCtx<FsConfig> } & Recorded {
  const recorded = record();
  return { ctx: { ...services(options, recorded), config: options.config, run: runInfo(), signal: options.signal ?? new AbortController().signal }, ...recorded };
}

/** A system context (hooks, mentions, context, lifecycle). */
export function systemCtx(options: FakeOptions): SystemCtx<FsConfig> & { session: ReturnType<typeof mintId<'session'>>; user: typeof user; time: TimeInfo } & Recorded {
  const recorded = record();
  const all = services(options, recorded);
  return { ...recorded, ...TEST_PLACE, ...NO_ASKS, system: 'fs', config: options.config, llm: all.llm, ai: all.ai, resources: all.resources, types: all.types, data: all.data, log: recorded.log, signal: options.signal ?? new AbortController().signal, session: mintId('session'), user, time };
}

/** The outcome of a run, narrowed to `done`, failing the test otherwise. */
export function doneResult<T extends FnTypes>(outcome: Outcome<T>): T['result'] {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${outcome.status}${outcome.status === 'failed' ? `: ${outcome.error.message}` : ''}`); }
  return outcome.result;
}

/** The error of a run, failing the test unless it failed. */
export function failure<T extends FnTypes>(outcome: Outcome<T>): FnError {
  if (outcome.status !== 'failed') { throw new Error(`expected failed, got ${outcome.status}`); }
  return outcome.error;
}

/** A shell that records commands and answers with what the test gives it. */
export class FakeShell implements Shell {
  readonly calls: Array<Parameters<Shell['run']>[0]> = [];
  private readonly answer: (input: Parameters<Shell['run']>[0]) => CommandRun;
  constructor(answer: (input: Parameters<Shell['run']>[0]) => CommandRun = () => ({ exitCode: 0, stdout: 'ok\n', stderr: '', ended: 'exit' })) {
    this.answer = answer;
  }

  run(input: Parameters<Shell['run']>[0]): Promise<CommandRun> {
    this.calls.push(input);
    input.onOutput?.(0.5, 'half way');
    return Promise.resolve(this.answer(input));
  }
}

/** Git that answers from a table of folders. */
export class FakeGit implements Git {
  private readonly table: ReadonlyMap<string, GitStatus>;
  constructor(table: ReadonlyMap<string, GitStatus>) {
    this.table = table;
  }

  status(folder: string): Promise<GitStatus | undefined> {
    return Promise.resolve(this.table.get(folder));
  }
}

/** A file manager that records what it was asked to show. */
export class FakeOpener implements Opener {
  readonly shown: string[] = [];
  reveal(path: string): Promise<boolean> {
    this.shown.push(path);
    return Promise.resolve(true);
  }
}

/** A restarter that records the reasons. */
export class FakeRestarter implements Restarter {
  readonly reasons: string[] = [];
  schedule(reason: string): void {
    this.reasons.push(reason);
  }
}

/** Git that ignores nothing, for the `gitignored` rule where git doesn't matter. */
export const NO_IGNORES: IgnoreCheck = { ignored: () => Promise.resolve(new Set()) };

/** Git that ignores the paths given (absolute, normalized). */
export function ignoring(paths: readonly string[]): IgnoreCheck {
  return { ignored: (asked) => Promise.resolve(new Set(asked.filter((path) => paths.includes(path)))) };
}

/** Change capture that answers a set change set for every call and records the folders it was started in. */
export class FakeChanges implements ChangeCapture {
  readonly started: string[] = [];
  private readonly answer: (cwd: string) => ChangeSet;
  constructor(answer: (cwd: string) => ChangeSet = (cwd) => ({ source: 'git', cwd, files: [], ignored: 0, truncated: false })) {
    this.answer = answer;
  }

  start(input: { cwd: string }): Promise<CaptureSession> {
    this.started.push(input.cwd);
    return Promise.resolve({ finish: () => Promise.resolve(this.answer(input.cwd)) });
  }

  busy(): () => void {
    return () => undefined;
  }
}
