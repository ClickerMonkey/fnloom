/**
 * Calls a run makes to other fns. Each call goes to the hub (`HubLink.call`), which queues it like every run, so the
 * hub sees the whole tree and applies permissions and budgets. Every call has a key, unique within its run: a resumed
 * run gets the results of calls that already finished back by key instead of calling again. When the run is paused
 * while waiting, pending calls reject with `Suspended`, which the runtime turns into the paused outcome.
 */
import {
  HandlerAnswer, type ControlReply, type Json, type QualifiedName, type ResumeWire, type RunId, type RunSettled, type RunUpdate,
} from '@harness/core';
import { CallFailed, HandlerFailed, type Suspended, type CallOptions, type FnCall, type Settled } from '../ctx.ts';
import type { Handlers } from '../fn.ts';
import type { GinType } from '../gin.ts';
import type { HubAccess } from './link.ts';
import type { ScopedLog } from './log.ts';
import { Deferred, decode, encode, encodeOrThrow, fnError, isDisconnected, messageOf, settledOf, thrownError } from './wire.ts';

/** What a call needs to know about the fn it calls. */
export interface CallTarget {
  readonly name: QualifiedName;
  readonly args: GinType;
  readonly returns: GinType;
  readonly handlers: Handlers;
}

/** A call as the run's call set tracks it, whatever its result type. */
interface OpenCall {
  heard(run: RunId, update: RunUpdate | undefined): void;
  fail(error: unknown): void;
}

/** One call in flight. Await it for the result, or use `settled` (never throws, except `Suspended`). */
class ChildCall<R> implements FnCall<R>, OpenCall {
  readonly key: string;
  readonly run: Promise<RunId>;
  readonly settled: Promise<Settled<R>>;
  readonly #run = new Deferred<RunId>();
  readonly #settled = new Deferred<Settled<R>>();
  readonly #watchers = new Set<(update: RunUpdate) => void>();
  readonly #abort = new AbortController();
  readonly #control: (run: RunId, action: 'cancel' | 'pause') => Promise<ControlReply>;
  #result: Promise<R> | undefined;
  #known: RunId | undefined;

  constructor(key: string, control: (run: RunId, action: 'cancel' | 'pause') => Promise<ControlReply>) {
    this.key = key;
    this.#control = control;
    this.run = this.#run.promise;
    this.settled = this.#settled.promise;
    // a caller that only awaits the result never looks at `run`; don't let its rejection go unhandled
    this.run.catch(() => undefined);
    this.settled.catch(() => undefined);
  }

  /** Aborts the underlying hub call (the hub cancels the child). */
  get signal(): AbortSignal { return this.#abort.signal; }

  then<A = R, B = never>(onDone?: ((value: R) => A | PromiseLike<A>) | null, onFail?: ((reason: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    this.#result ??= this.settled.then((settled) => {
      if (settled.status === 'done') { return settled.result; }
      throw new CallFailed(this.#known, settled.status === 'failed' ? settled.error : { class: 'cancelled' });
    });
    return this.#result.then(onDone, onFail);
  }

  async cancel(): Promise<void> {
    if (this.#run.settled) {
      await this.#control(await this.run, 'cancel');
    } else {
      this.#abort.abort(new Error('cancelled by the caller'));
    }
  }

  async pause(): Promise<void> {
    const reply = await this.#control(await this.run, 'pause');
    if (!reply.accepted) { throw new Error(reply.reason ?? 'The child run cannot pause right now.'); }
  }

  watch(listener: (update: RunUpdate) => void): () => void {
    this.#watchers.add(listener);
    return () => { this.#watchers.delete(listener); };
  }

  /** The hub created the child, or it changed. */
  heard(run: RunId, update: RunUpdate | undefined): void {
    this.#known = run;
    this.#run.resolve(run);
    if (update === undefined) { return; }
    for (const watcher of this.#watchers) { watcher(update); }
  }

  settle(settled: Settled<R>, run?: RunId): void {
    if (run !== undefined) {
      this.#known = run;
      this.#run.resolve(run);
    }
    this.#run.reject(new Error('The hub did not report the child run.'));
    this.#settled.resolve(settled);
  }

  fail(error: unknown): void {
    this.#run.reject(error);
    this.#settled.reject(error);
  }
}

/** The handlers a call supplied, so the hub can relay the child's handler calls back to them. */
interface Supplied {
  readonly target: CallTarget;
  readonly fns: Readonly<Record<string, ((args: unknown) => Promise<unknown>) | undefined>>;
}

/** Everything one run calls: keys, resumed results, supplied handlers, and suspension. */
export class CallSet {
  readonly #hub: HubAccess;
  readonly #parent: RunId;
  readonly #resumed: Readonly<Record<string, RunSettled>>;
  readonly #signal: AbortSignal;
  readonly #log: ScopedLog;
  readonly #counters = new Map<string, number>();
  readonly #open = new Map<string, OpenCall>();
  readonly #supplied = new Map<string, Supplied>();
  #suspended: Suspended | undefined;

  constructor(options: { hub: HubAccess; parent: RunId; resume: ResumeWire | undefined; signal: AbortSignal; log: ScopedLog }) {
    this.#hub = options.hub;
    this.#parent = options.parent;
    this.#resumed = options.resume?.calls ?? {};
    this.#signal = options.signal;
    this.#log = options.log;
  }

  /** Call `target` as the dep named `local`. */
  call<R>(target: CallTarget & { returns: GinType<R> }, local: string, args: unknown, options: CallOptions<Handlers> | undefined): FnCall<R> {
    const key = options?.key ?? this.#nextKey(local);
    const call = new ChildCall<R>(key, (run, action) => this.#control(run, action));
    if (this.#suspended !== undefined) {
      call.fail(this.#suspended);
      return call;
    }
    const resumed = this.#resumed[key];
    if (resumed !== undefined) {
      call.settle(settledOf(target.returns, resumed, `The result of ${target.name}`), resumed.status === 'background' ? resumed.run : undefined);
      return call;
    }
    if (this.#open.has(key)) {
      call.fail(new Error(`Two calls in this run use the key ${key}; give each call its own key.`));
      return call;
    }
    const encoded = encode(target.args, args, `The args of ${target.name}`);
    if (!encoded.ok) {
      call.settle({ status: 'failed', error: encoded.error });
      return call;
    }
    const handlers = options?.handlers ?? {};
    this.#supplied.set(key, { target, fns: handlers });
    this.#open.set(key, call);
    void this.#send(call, target, key, encoded.value, options, Object.keys(handlers));
    return call;
  }

  /** The hub created a child run for a call, or it changed. */
  heard(key: string, run: RunId, update: RunUpdate | undefined): void {
    const call = this.#open.get(key);
    call?.heard(run, update);
  }

  /** Answer a handler the hub relays from a child (`SystemLink.handler`). */
  async answer(key: string, handler: string, args: Json): Promise<HandlerAnswer> {
    const supplied = this.#supplied.get(key);
    const def = supplied?.target.handlers[handler];
    const fn = supplied?.fns[handler];
    if (def === undefined || fn === undefined) {
      return { ok: false, error: fnError('caller', `The call ${key} supplied no handler ${handler}.`, { code: 'no-handler' }) };
    }
    const input = decode(def.args, args, `The args of handler ${handler}`);
    if (!input.ok) { return { ok: false, error: input.error }; }
    try {
      const value = encode(def.returns, await fn(input.value), `The answer of handler ${handler}`);
      return value.ok ? { ok: true, value: value.value } : { ok: false, error: value.error };
    } catch (error) {
      return { ok: false, error: thrownError(error) };
    }
  }

  /** The run is pausing: every pending call rejects with `Suspended`, and no new call starts. */
  suspend(error: Suspended): void {
    this.#suspended = error;
    for (const call of this.#open.values()) { call.fail(error); }
    this.#open.clear();
  }

  #nextKey(local: string): string {
    const count = (this.#counters.get(local) ?? 0) + 1;
    this.#counters.set(local, count);
    return `${local}#${count}`;
  }

  async #send<R>(call: ChildCall<R>, target: CallTarget & { returns: GinType<R> }, key: string, args: Json, options: CallOptions<Handlers> | undefined, handlers: string[]): Promise<void> {
    const signal = AbortSignal.any([this.#signal, call.signal]);
    const body = {
      parent: this.#parent,
      fn: target.name,
      args,
      key,
      handlers,
      background: options?.background ?? false,
      ...(options?.budget === undefined ? {} : { budget: options.budget }),
    };
    try {
      // the hub dedupes calls by parent and key, so a call cut off by a dropped link is sent again on the next one
      for (;;) {
        const hub = await this.#hub.ready(signal);
        try {
          const settled = await hub.call('call', body, { signal });
          if (this.#open.get(key) === call) {
            call.settle(settledOf(target.returns, settled, `The result of ${target.name}`), settled.status === 'background' ? settled.run : undefined);
          }
          return;
        } catch (error) {
          if (!isDisconnected(error) || signal.aborted) { throw error; }
          this.#log.info('call.retry', { fn: target.name, key });
        }
      }
    } catch (error) {
      if (this.#open.get(key) !== call) { return; }
      if (signal.aborted) {
        call.settle({ status: 'cancelled' });
      } else {
        this.#log.warn('call.failed', { fn: target.name, key, error: messageOf(error) });
        call.settle({ status: 'failed', error: fnError('retry', `Calling ${target.name} failed: ${messageOf(error)}`, { code: 'link' }) });
      }
    } finally {
      if (this.#open.get(key) === call) { this.#open.delete(key); }
    }
  }

  async #control(run: RunId, action: 'cancel' | 'pause'): Promise<ControlReply> {
    const hub = await this.#hub.ready(this.#signal);
    return hub.call('control', { run, action });
  }
}

/** A run's own handler as the fn sees it: asks the hub, which relays to whoever answers for the caller. */
export function runHandler(hub: HubAccess, run: RunId, name: string, def: { args: GinType; returns: GinType }, signal: AbortSignal): (args: unknown) => Promise<unknown> {
  return async (args) => {
    const link = await hub.ready(signal);
    const answer = HandlerAnswer.parse(await link.call('handle', { run, handler: name, args: encodeOrThrow(def.args, args, `The args of handler ${name}`) }, { signal }));
    if (!answer.ok) { throw new HandlerFailed(name, answer.error); }
    const value = decode(def.returns, answer.value, `The answer of handler ${name}`);
    if (!value.ok) { throw new HandlerFailed(name, value.error); }
    return value.value;
  };
}
