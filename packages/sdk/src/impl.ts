/** The implementation shapes a system's server writes, computed from what its contract declares. */
import type { PreviewAnswer, UndoOutcome } from '@harness/core';
import type { FnCtx, PreviewCtx, UndoCtx } from './ctx.ts';
import type { FnTypes, Outcome } from './fn.ts';

/**
 * The implementation of a native fn. `undo` is required exactly when the fn declares an undo type; `preview` when it
 * declares `approval` with a preview (checked when the system serves): what a run would do, or why it can't go ahead.
 */
export type FnImpl<T extends FnTypes, Cfg = unknown> =
  { run(args: T['args'], ctx: FnCtx<T, Cfg>): Promise<Outcome<T>>; preview?(args: T['args'], ctx: PreviewCtx<Cfg>): Promise<PreviewAnswer> } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx<Cfg>): Promise<UndoOutcome> });
