/**
 * The execution module's errors. Each carries what its handler needs (a `FnError` to hand back, a wait before trying
 * again), and `causeOf` finds one inside a wrapper (aeye wraps errors thrown by hooks in its own).
 */
import { messageOf, type BudgetId, type ErrorClass, type FnError } from '@harness/core';

/** Make a `FnError`. */
export function fnError(errorClass: ErrorClass, message: string, code?: string): FnError {
  return code === undefined ? { class: errorClass, message } : { class: errorClass, message, code };
}

/** A run could not be started: the fn is unknown, unavailable, not a declared dep, or its args don't fit. */
export class RunRefused extends Error {
  override readonly name = 'RunRefused';
  readonly error: FnError;

  constructor(error: FnError) {
    super(error.message);
    this.error = error;
  }
}

/** An LLM call would take a budget over. `wait` is set when the budget's rule says to wait for its window. */
export class BudgetRefused extends Error {
  override readonly name = 'BudgetRefused';
  readonly budget: BudgetId;
  readonly wait: number | undefined;

  constructor(reason: string, budget: BudgetId, wait?: number) {
    super(reason);
    this.budget = budget;
    this.wait = wait;
  }
}

/** Too many LLM calls started on a model (or in all) in the current window; try again after `retryAfter`. */
export class LlmRateLimited extends Error {
  override readonly name = 'LlmRateLimited';
  readonly retryAfter: number;

  constructor(key: string, retryAfter: number) {
    super(`LLM calls on ${key} are rate-limited for ${retryAfter} ms`);
    this.retryAfter = retryAfter;
  }
}

/** A run was cancelled or paused while an executor was working on it. */
export class RunStopped extends Error {
  override readonly name = 'RunStopped';
  readonly how: 'cancel' | 'pause';

  constructor(how: 'cancel' | 'pause') {
    super(how === 'cancel' ? 'the run was cancelled' : 'the run was paused');
    this.how = how;
  }
}

/** The hub is shutting down: work in flight stops and is picked up again after the restart. */
export class HubStopping extends Error {
  override readonly name = 'HubStopping';

  constructor() {
    super('the hub is shutting down');
  }
}

/** The first error of a class in an error's `cause` chain (the error itself included). */
export function causeOf<E extends Error>(error: unknown, type: abstract new (...args: never[]) => E): E | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof type) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

/** The message of anything thrown (one definition, in `@harness/core`). */
export { messageOf };
