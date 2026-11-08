/**
 * Moving values between gin and the wire. Every value that crosses the link is checked against its declared gin type
 * on the way in (`decode`: fns receive plain values, dates as `Date`) and encoded on the way out (`encode`: JSON). A
 * value that does not fit becomes a `FnError` the hub and the LLM can act on, never a crash.
 */
import { ApiError, DISCONNECTED_STATUS } from '@ayepi/core';
import { FnError, messageOf, type Json, type ErrorClass, type RunSettled } from '@harness/core';
import { CallFailed, HandlerFailed, Suspended, type Settled } from '../ctx.ts';
import { encodeValue, parseValue, type GinType } from '../gin.ts';

/** A value that did or did not fit its type. */
export type Checked<T> = { ok: true; value: T } | { ok: false; error: FnError };

/** The message of anything thrown (one definition, in `@harness/core`). */
export { messageOf };

/** Make a `FnError`. */
export function fnError(cls: ErrorClass, message: string, extra?: { code?: string; data?: Json }): FnError {
  return FnError.parse({ class: cls, message, ...(extra?.code === undefined ? {} : { code: extra.code }), ...(extra?.data === undefined ? {} : { data: extra.data }) });
}

/** Check a wire value against a gin type, giving the plain value fns receive. `what` names it in the error. */
export function decode<T>(type: GinType<T>, value: unknown, what: string): Checked<T> {
  try {
    return { ok: true, value: parseValue(type, value) };
  } catch (error) {
    return { ok: false, error: fnError('caller', `${what} does not fit its type: ${messageOf(error)}`, { code: 'bad-value' }) };
  }
}

/** Encode a plain value for the wire, checking it fits. `what` names it in the error. */
export function encode<T>(type: GinType<T>, value: T, what: string): Checked<Json> {
  try {
    return { ok: true, value: encodeValue(type, value) };
  } catch (error) {
    return { ok: false, error: fnError('fatal', `${what} does not fit its declared type: ${messageOf(error)}`, { code: 'bad-value' }) };
  }
}

/** `decode`, throwing the `FnError` as an `InvalidValue` when the value does not fit. */
export function decodeOrThrow<T>(type: GinType<T>, value: unknown, what: string): T {
  const checked = decode(type, value, what);
  if (!checked.ok) { throw new InvalidValue(checked.error); }
  return checked.value;
}

/** `encode`, throwing the `FnError` as an `InvalidValue` when the value does not fit. */
export function encodeOrThrow<T>(type: GinType<T>, value: T, what: string): Json {
  const checked = encode(type, value, what);
  if (!checked.ok) { throw new InvalidValue(checked.error); }
  return checked.value;
}

/** A value did not fit its declared type. Carries the `FnError` to report. */
export class InvalidValue extends Error {
  override readonly name = 'InvalidValue';
  readonly error: FnError;
  constructor(error: FnError) {
    super(error.message);
    this.error = error;
  }
}

/** Something the link cannot do yet (the hub offers no endpoint for it). */
export class LinkGap extends Error {
  override readonly name = 'LinkGap';
}

/** Whether an error is the link dropping (the call may be retried on the next connection). */
export function isDisconnected(error: unknown): boolean {
  return error instanceof ApiError && error.status === DISCONNECTED_STATUS;
}

/** What a run that threw becomes. A dep's or handler's failure keeps its error; anything else is fatal. */
export function thrownError(error: unknown): FnError {
  if (error instanceof InvalidValue) { return error.error; }
  if (error instanceof CallFailed) {
    return error.error.class === 'cancelled'
      ? fnError('fatal', error.message, { code: 'dep-cancelled' })
      : error.error;
  }
  // the hub's own error (refused, failed, timed out) or why the answer didn't fit, so the caller sees what happened
  if (error instanceof HandlerFailed) { return error.error; }
  if (error instanceof Suspended) { return fnError('retry', error.message, { code: 'suspended' }); }
  return fnError('fatal', messageOf(error), { code: 'threw' });
}

/** A child call's settlement, decoded against the dep's result type. */
export function settledOf<R>(type: GinType<R>, settled: RunSettled, what: string): Settled<R> {
  switch (settled.status) {
    case 'done': {
      const result = decode(type, settled.result, what);
      return result.ok ? { status: 'done', result: result.value } : { status: 'failed', error: result.error };
    }
    case 'failed': return { status: 'failed', error: settled.error };
    case 'cancelled': return { status: 'cancelled' };
    case 'background': return {
      status: 'failed',
      error: fnError('caller', 'The call moved to the background; follow it with hub/run_wait.', { code: 'background', data: { run: settled.run } }),
    };
  }
}

/** A promise with its resolvers, for waiting on something another part of the runtime settles. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve: (value: T) => void = () => undefined;
  #reject: (error: unknown) => void = () => undefined;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get settled(): boolean { return this.#settled; }

  resolve(value: T): void {
    if (this.#settled) { return; }
    this.#settled = true;
    this.#resolve(value);
  }

  reject(error: unknown): void {
    if (this.#settled) { return; }
    this.#settled = true;
    this.#reject(error);
  }
}
