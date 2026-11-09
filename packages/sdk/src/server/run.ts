/**
 * One run on this system: the context its fn gets, built from the fn's declaration, and the outcome it settles with.
 *
 * - Args, results, undo and resume payloads, form values and handler answers are checked against their gin types.
 * - `cancel` aborts `ctx.signal`; the fn finishes (cancelled, or with what it managed) and that is reported.
 * - `pause` asks the fn's `onPause` hook for its resume state, rejects its pending calls with `Suspended`, and settles
 *   at once as paused; a resumed run gets finished calls back by key.
 * - The deadline aborts `ctx.signal` too; a run that then fails is reported as timed out.
 * - Progress, attachments and links go to the hub as they happen and are flushed before the outcome is sent.
 */
import {
  OutcomeWire, type AllowedOperations, type ControlReply, type Detail, type FnError, type InvalidInput, type Json, type Link, type QualifiedName, type RunId,
  type RunRequest, type StepStatus, type Usd, type RunControlAction,
} from '@harness/core';
import { Suspended, type BudgetInfo, type CallOptions, type Resume, type Services, type Settled, type SystemPlace } from '../ctx.ts';
import type { Deps, Handlers, ProgressDef } from '../fn.ts';
import { json, type GinType } from '../gin.ts';
import type { AttachmentRef, SettingRef } from '../refs.ts';
import { CallSet, runHandler, type CallTarget } from './calls.ts';
import type { ContentTransfer } from './content.ts';
import type { FilesFactory } from './files.ts';
import type { HubAccess, HubLink } from './link.ts';
import { HubLlm } from './llm.ts';
import type { ScopedLog } from './log.ts';
import { HubResources } from './resources.ts';
import { HubTypes } from './types.ts';
import { LinkState, stateRecordType } from './state.ts';
import type { AnyOutcome, OutcomeHelpers, RunTarget, RuntimeFnCtx, RuntimeKindCtx, RuntimeProgress, RuntimeRunBase } from './table.ts';
import { decodeArgs, decodeOrThrow, encode, encodeOrThrow, fnError, invalidInput, InvalidValue, messageOf, settledOf, thrownError } from './wire.ts';

/** What every run gets from the runtime. */
export interface RunEnvironment {
  readonly system: string;
  readonly hub: HubAccess;
  readonly content: ContentTransfer;
  readonly files: FilesFactory;
  readonly fetch: typeof fetch;
  readonly log: ScopedLog;
  /** Which instance this is and where it keeps its data and cache. */
  readonly place: SystemPlace;
  readonly stateRetries: number;
  readonly now: () => number;
  /** The config value of a version, or `undefined` when it isn't known (any more). */
  config(version: number): { value: unknown } | undefined;
  /** The version of the current valid config, if there is one. */
  currentConfig(): number | undefined;
}

/** The types a run's values are checked against, from its declaration. */
interface Shape {
  readonly args: GinType;
  readonly returns: GinType;
  readonly undo: GinType | undefined;
  readonly resume: GinType | undefined;
  readonly state: GinType<Record<string, unknown>> | undefined;
  readonly form: GinType | undefined;
  readonly deps: Deps;
  readonly handlers: Handlers;
  readonly progress: ProgressDef;
  readonly operations: { cancel: boolean; pause: boolean; background: boolean };
}

function shapeOf(target: RunTarget): Shape {
  if (target.kind === 'kind') {
    return {
      args: json(), returns: json(), undo: json(), resume: json(), state: undefined, form: json(), deps: {}, handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: true, background: true },
    };
  }
  const def = target.def;
  return {
    args: target.kind === 'method' ? target.argsType : def.args,
    returns: def.returns,
    undo: def.undo,
    resume: def.resume,
    state: stateRecordType(def.state),
    form: def.form,
    deps: def.deps,
    handlers: def.handlers,
    progress: def.progress,
    operations: { cancel: def.operations.cancel, pause: def.operations.pause, background: def.operations.background },
  };
}

/** Why a run's signal aborted. */
class Stop extends Error {
  override readonly name = 'Stop';
  readonly why: 'cancel' | 'timeout' | 'pause';
  constructor(why: 'cancel' | 'timeout' | 'pause') {
    super(why === 'cancel' ? 'The run was cancelled.' : why === 'timeout' ? 'The run passed its deadline.' : 'The run is pausing.');
    this.why = why;
  }
}

/** Sends something to the hub in the background. */
export type Track = (send: (hub: HubLink) => Promise<unknown>) => void;

/**
 * The services a run (or an undo) gets, acting for `run`: LLM calls on its budget, files, fetch, resources, checked
 * attachments and links, its user's settings, and its log.
 */
export function servicesFor(env: RunEnvironment, run: RunId, signal: AbortSignal, log: ScopedLog, track: Track): Services {
  return {
    ...env.place,
    llm: new HubLlm({ hub: env.hub, content: env.content, run }, signal),
    files: env.files({ content: env.content, signal }),
    fetch: env.fetch,
    resources: new HubResources(env.hub, env.content, { run, signal }),
    types: new HubTypes(env.hub, signal),
    ...runReporting(env, run, signal, track),
    log,
  };
}

/** The services that act on a run's message and its user: attachments, links and settings. */
export function runReporting(env: RunEnvironment, run: RunId, signal: AbortSignal, track: Track): Pick<Services, 'attach' | 'link' | 'setting'> {
  return {
    attach: <A>(attachment: AttachmentRef<QualifiedName, A>, data: A, title: string): void => {
      const encoded = encodeOrThrow(attachment.data, data, `The ${attachment.name} attachment`);
      track((hub) => hub.call('attach', { run, item: { attachment: attachment.name, data: encoded, title } }));
    },
    link: (link: Link): void => { track((hub) => hub.call('attach', { run, item: { link } })); },
    setting: async <V>(setting: SettingRef<QualifiedName, V>): Promise<V | undefined> => {
      const hub = await env.hub.ready(signal);
      const { value } = await hub.call('setting', { run, setting: setting.name }, { signal });
      return value === undefined ? undefined : decodeOrThrow(setting.type, value, `Setting ${setting.name}`);
    },
  };
}

/** The outcome helpers: they build the outcome object; the runtime checks it against the fn's types. */
function outcomeHelpers(): OutcomeHelpers {
  return {
    done: (result, extra) => ({ status: 'done', result, ...(extra?.undo === undefined ? {} : { undo: extra.undo }), ...(extra?.cost === undefined ? {} : { cost: extra.cost }) }),
    invalid: (problems, extra) => ({ status: 'invalid-input', invalid: invalidInput(problems), ...(extra?.cost === undefined ? {} : { cost: extra.cost }) }),
    fail: (cls, message, extra) => ({
      status: 'failed',
      error: fnError(cls, message, { ...(extra?.code === undefined ? {} : { code: extra.code }), ...(extra?.data === undefined ? {} : { data: extra.data }) }),
      ...(extra?.undo === undefined ? {} : { undo: extra.undo }),
      ...(extra?.cost === undefined ? {} : { cost: extra.cost }),
    }),
    pause: (resume, extra) => ({ status: 'paused', resume, ...(extra?.cost === undefined ? {} : { cost: extra.cost }) }),
    cancelled: (extra) => ({
      status: 'cancelled',
      ...(extra?.partial === undefined ? {} : { partial: extra.partial }),
      ...(extra?.undo === undefined ? {} : { undo: extra.undo }),
      ...(extra?.cost === undefined ? {} : { cost: extra.cost }),
    }),
  };
}

/** One run in progress. */
export class ActiveRun {
  readonly id: RunId;
  readonly #request: RunRequest;
  readonly #target: RunTarget;
  readonly #shape: Shape;
  readonly #env: RunEnvironment;
  readonly #log: ScopedLog;
  readonly #abort = new AbortController();
  readonly #calls: CallSet;
  readonly #pending = new Set<Promise<void>>();
  readonly #forms: unknown[] = [];
  readonly #formWaiters: Array<(value: unknown) => void> = [];
  readonly #started: number;
  #allowed: AllowedOperations;
  #pauseHook: (() => unknown) | undefined;
  #pausedWith: { state: unknown } | undefined;
  #onPaused: ((state: unknown) => void) | undefined;
  #undo: unknown;
  /** The fns the result shows the agent (`ctx.expose`), by name: the last detail asked for wins. */
  readonly #exposed = new Map<QualifiedName, Detail>();
  #spent = 0;
  #outcome: Promise<OutcomeWire> | undefined;

  constructor(request: RunRequest, target: RunTarget, env: RunEnvironment) {
    this.id = request.run.id;
    this.#request = request;
    this.#target = target;
    this.#shape = shapeOf(target);
    this.#env = env;
    this.#log = env.log.with({ run: request.run.id, fn: request.run.fn });
    this.#started = env.now();
    this.#allowed = { ...this.#shape.operations };
    this.#calls = new CallSet({ hub: env.hub, parent: this.id, resume: request.resume, signal: this.#abort.signal, log: this.#log });
  }

  /** Run it (once); resolves with the outcome as it goes to the hub. */
  outcome(): Promise<OutcomeWire> {
    this.#outcome ??= this.#settle();
    return this.#outcome;
  }

  /** Cancel or pause, as the hub asks. */
  async control(action: RunControlAction): Promise<ControlReply> {
    if (action === 'cancel') {
      if (!this.#allowed.cancel) { return { accepted: false, reason: 'This run can\'t be cancelled right now.' }; }
      this.#abort.abort(new Stop('cancel'));
      return { accepted: true };
    }
    if (!this.#allowed.pause || this.#shape.resume === undefined) { return { accepted: false, reason: 'This run can\'t pause.' }; }
    const hook = this.#pauseHook;
    if (hook === undefined) { return { accepted: false, reason: 'This run can\'t pause right now: it has no pause hook.' }; }
    const state = await hook();
    this.#pausedWith = { state };
    this.#calls.suspend(new Suspended(this.id));
    this.#abort.abort(new Stop('pause'));
    this.#onPaused?.(state);
    return { accepted: true };
  }

  /** A form submission from the run's renderer. Waits for `ctx.form()` if it hasn't been called yet. */
  submit(value: Json): void {
    const form = this.#shape.form;
    if (form === undefined) { throw new Error(`Run ${this.id} has no form.`); }
    const checked = decodeOrThrow(form, value, 'The form value');
    const waiter = this.#formWaiters.shift();
    if (waiter === undefined) { this.#forms.push(checked); } else { waiter(checked); }
  }

  /** The call set, for the hub's relayed handler calls and child notices. */
  get calls(): CallSet { return this.#calls; }

  /**
   * Run the fn to its outcome. At the deadline the signal aborts and the run settles as a timeout straight away, even
   * if the fn ignores the signal or answers it with `cancelled`: the deadline passed either way.
   */
  async #settle(): Promise<OutcomeWire> {
    let expire: () => void = () => undefined;
    const expired = new Promise<AnyOutcome>((resolve) => { expire = () => { resolve(timedOut('it was stopped')); }; });
    const deadline = setTimeout(() => {
      this.#abort.abort(new Stop('timeout'));
      expire();
    }, Math.max(0, this.#request.deadline - this.#env.now()));
    let outcome: AnyOutcome;
    try {
      const paused = new Promise<AnyOutcome>((resolve) => { this.#onPaused = (state) => { resolve({ status: 'paused', resume: state }); }; });
      outcome = await Promise.race([this.#execute(), paused, expired]);
    } catch (error) {
      outcome = this.#thrown(error);
    } finally {
      clearTimeout(deadline);
    }
    if (this.#pausedWith !== undefined) { outcome = { status: 'paused', resume: this.#pausedWith.state }; }
    await Promise.allSettled([...this.#pending]);
    const wire = this.#wire(outcome);
    this.#log.info('run.settled', { status: wire.status, ms: this.#env.now() - this.#started });
    return wire;
  }

  /** Whether the run's signal aborted for this reason. */
  #stoppedBy(why: Stop['why']): boolean {
    const reason: unknown = this.#abort.signal.reason;
    return reason instanceof Stop && reason.why === why;
  }

  #thrown(error: unknown): AnyOutcome {
    if (this.#stoppedBy('cancel')) { return { status: 'cancelled' }; }
    if (this.#stoppedBy('timeout')) { return timedOut(messageOf(error)); }
    if (!(error instanceof InvalidValue) && !(error instanceof Suspended)) { this.#log.error('run.threw', {}, error); }
    return { status: 'failed', error: thrownError(error) };
  }

  async #execute(): Promise<AnyOutcome> {
    const target = this.#target;
    switch (target.kind) {
      case 'native': {
        const args = decodeArgs(this.#shape.args, this.#request.args);
        return args.ok ? target.impl.run(args.value, this.#fnCtx()) : this.#refused(args.invalid);
      }
      case 'method': {
        const args = decodeArgs(this.#shape.args, this.#request.args);
        if (!args.ok) { return this.#refused(args.invalid); }
        const { self, rest } = splitSelf(args.value);
        return target.impl.run(self, rest, this.#fnCtx());
      }
      case 'kind': return target.impl.run(decodeOrThrow(target.def.payload, this.#request.payload, 'The payload'), this.#request.args, this.#kindCtx());
    }
  }

  /** Args that don't fit the fn's type: the caller's mistake, which an agent retries. */
  #refused(invalid: InvalidInput): AnyOutcome {
    this.#log.info('run.invalid-input', { source: invalid.source, problems: invalid.problems.length });
    return { status: 'invalid-input', invalid };
  }

  /** The outcome on the wire: values encoded with the fn's types, the undo payload it registered, costs it reported. */
  #wire(outcome: AnyOutcome): OutcomeWire {
    const cost = this.#spent + (outcome.cost ?? 0);
    const costed = outcome.cost === undefined && this.#spent === 0 ? {} : { cost };
    if (outcome.status === 'invalid-input') { return OutcomeWire.parse({ status: 'invalid-input', invalid: outcome.invalid, ...costed }); }
    if (outcome.status === 'paused') {
      const resume = this.#encode(this.#shape.resume, outcome.resume, 'The resume state');
      return resume.ok ? OutcomeWire.parse({ status: 'paused', resume: resume.value, ...costed }) : this.#failed(resume.error, costed);
    }
    const undoValue = outcome.undo ?? this.#undo;
    const undo = undoValue === undefined ? undefined : this.#encode(this.#shape.undo, undoValue, 'The undo payload');
    if (undo !== undefined && !undo.ok) { return this.#failed(undo.error, costed); }
    const undoPart = undo === undefined ? {} : { undo: undo.value };
    switch (outcome.status) {
      case 'done': {
        const result = encode(this.#shape.returns, outcome.result, 'The result');
        const expose = [...this.#exposed].map(([fn, detail]) => ({ fn, detail }));
        return result.ok
          ? OutcomeWire.parse({ status: 'done', result: result.value, ...undoPart, ...costed, ...(expose.length === 0 ? {} : { expose }) })
          : this.#failed(result.error, costed);
      }
      case 'failed': return OutcomeWire.parse({ status: 'failed', error: outcome.error, ...undoPart, ...costed });
      case 'cancelled': {
        const partial = outcome.partial === undefined ? undefined : encode(this.#shape.returns, outcome.partial, 'The partial result');
        return OutcomeWire.parse({ status: 'cancelled', ...(partial?.ok === true ? { partial: partial.value } : {}), ...undoPart, ...costed });
      }
    }
  }

  #failed(error: FnError, costed: { cost?: Usd }): OutcomeWire {
    this.#log.warn('run.bad-outcome', { message: error.message });
    return OutcomeWire.parse({ status: 'failed', error, ...costed });
  }

  #encode(type: GinType | undefined, value: unknown, what: string): { ok: true; value: Json } | { ok: false; error: FnError } {
    if (type === undefined) { return { ok: false, error: fnError('fatal', `${what} was given, but the fn declares no type for it.`, { code: 'bad-value' }) }; }
    return encode(type, value, what);
  }

  // ─── The context ────────────────────────────────────────────────────────────

  #base(): RuntimeRunBase {
    const request = this.#request;
    const env = this.#env;
    const signal = this.#abort.signal;
    const config = env.config(request.configVersion);
    if (config === undefined) { throw new InvalidValue(fnError('retry', `Config version ${request.configVersion} is not known here yet.`, { code: 'config' })); }
    const form = this.#shape.form;
    return {
      ...outcomeHelpers(),
      ...servicesFor(env, this.id, signal, this.#log, (send) => { this.#track(send); }),
      config: config.value,
      run: request.run,
      budget: this.#budget(),
      signal,
      state: new LinkState(env.hub, { run: this.id }, this.#shape.state, { retries: env.stateRetries, signal }),
      form: form === undefined ? undefined : () => this.#nextForm(),
      resume: this.#resume(),
      connection: request.connection,
      updateConnection: async (update) => {
        const connection = request.connection;
        if (connection === undefined) { throw new Error(`Run ${this.id} acts as no connection.`); }
        const hub = await env.hub.ready(signal);
        await hub.call('connectionUpdate', { connection: connection.id, update });
      },
      shareFn: async (fn, share) => {
        const hub = await env.hub.ready(signal);
        await hub.call('shareFn', { run: this.id, fn, share });
      },
      usableFns: async (fns) => {
        if (fns.length === 0) { return []; }
        const hub = await env.hub.ready(signal);
        return (await hub.call('usableFns', { run: this.id, fns: [...fns] })).fns;
      },
      onPause: (hook) => { this.#pauseHook = hook; },
      allow: (operations) => {
        this.#allowed = { ...this.#allowed, ...operations };
        this.#track((hub) => hub.call('allow', { run: this.id, operations }));
      },
      expose: (fn, detail) => { this.#exposed.set(fn.name, detail ?? 'signature'); },
      undoWith: (payload) => {
        this.#undo = payload;
        this.#track((hub) => hub.call('undoWith', { run: this.id, undo: encodeOrThrow(this.#required(this.#shape.undo, 'undo'), payload, 'The undo payload') }));
      },
    };
  }

  #fnCtx(): RuntimeFnCtx {
    const signal = this.#abort.signal;
    const fns = Object.fromEntries(Object.entries(this.#shape.deps).map(([local, dep]) => [
      local,
      (args: unknown, options?: CallOptions<Handlers>) => this.#calls.call(dep, local, args, options),
    ]));
    const offered = new Set(this.#request.handlers);
    const handlers = Object.fromEntries(Object.entries(this.#shape.handlers).map(([name, def]) => [
      name,
      def.required || offered.has(name) ? runHandler(this.#env.hub, this.id, name, def, signal) : undefined,
    ]));
    return { ...this.#base(), fns, handlers, progress: this.#progress() };
  }

  #kindCtx(): RuntimeKindCtx {
    const signal = this.#abort.signal;
    const progress = this.#progress();
    return {
      ...this.#base(),
      call: (fn, args, options) => this.#calls.call(untypedTarget(fn), fn, args, options),
      handler: async (name, args) => {
        const answer = await runHandler(this.#env.hub, this.id, name, { args: json(), returns: json() }, signal)(args);
        return decodeOrThrow(json(), answer, `The answer of handler ${name}`);
      },
      progress: (state) => {
        if ('fraction' in state) { progress.set(state.fraction, state.message); } else { progress.step(state.step, state.status, state.detail); }
      },
    };
  }

  #progress(): RuntimeProgress {
    return {
      type: this.#shape.progress.type,
      set: (fraction, message) => {
        this.#track((hub) => hub.call('progress', { run: this.id, progress: { fraction: Math.min(1, Math.max(0, fraction)), ...(message === undefined ? {} : { message }) } }));
      },
      step: (step: string, status: StepStatus, detail?: string) => {
        this.#track((hub) => hub.call('progress', { run: this.id, progress: { step, status, ...(detail === undefined ? {} : { detail }) } }));
      },
    };
  }

  #budget(): BudgetInfo {
    const left = this.#request.budget;
    return {
      remaining: () => ({ cost: left.cost - this.#spent, time: Math.max(0, left.time - (this.#env.now() - this.#started)) }),
      limitedBy: () => left.limitedBy,
      spend: (cost, what) => {
        this.#spent += cost;
        this.#log.info('run.spent', { cost, what });
      },
    };
  }

  #resume(): Resume<unknown> | undefined {
    const resume = this.#request.resume;
    if (resume === undefined) { return undefined; }
    const calls: Record<string, Settled<Json>> = {};
    for (const [key, settled] of Object.entries(resume.calls)) { calls[key] = settledOf(json(), settled, `The result of call ${key}`); }
    const state = this.#shape.resume === undefined ? resume.state : decodeOrThrow(this.#shape.resume, resume.state, 'The resume state');
    return { state, calls, reason: resume.reason };
  }

  #nextForm(): Promise<unknown> {
    const ready = this.#forms.shift();
    if (ready !== undefined) { return Promise.resolve(ready); }
    return new Promise((resolve, reject) => {
      this.#formWaiters.push(resolve);
      this.#abort.signal.addEventListener('abort', () => {
        const reason: unknown = this.#abort.signal.reason;
        reject(reason instanceof Error ? reason : new Error('The run stopped.'));
      }, { once: true });
    });
  }

  #required(type: GinType | undefined, what: string): GinType {
    if (type === undefined) { throw new InvalidValue(fnError('fatal', `The fn declares no ${what} type.`, { code: 'bad-value' })); }
    return type;
  }

  /** Send something to the hub without blocking the fn; the outcome waits for it. Failures are logged. */
  #track(send: (hub: HubLink) => Promise<unknown>): void {
    const done = this.#env.hub.ready()
      .then(send)
      .then(() => undefined, (error: unknown) => { this.#log.warn('run.report-failed', { error: messageOf(error) }); })
      .finally(() => { this.#pending.delete(done); });
    this.#pending.add(done);
  }
}

/** The outcome of a run that passed its deadline: worth retrying with more time. */
function timedOut(detail: string): AnyOutcome {
  return { status: 'failed', error: fnError('retry', `The run passed its deadline: ${detail}`, { code: 'timeout' }) };
}

/** A method's args hold the value it is called on as `self`, beside its own args. */
function splitSelf(value: unknown): { self: unknown; rest: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) { return { self: undefined, rest: {} }; }
  const { self, ...rest } = Object.fromEntries(Object.entries(value));
  return { self, rest };
}

/** A call target known only by name (a kind's calls): JSON in and out, the hub checks the rest. */
function untypedTarget(name: QualifiedName): CallTarget & { returns: GinType<Json> } {
  return { name, args: json(), returns: json(), handlers: {} };
}
