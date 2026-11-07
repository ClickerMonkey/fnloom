/** The implementation shapes a system's server writes, computed from what its contract declares. */
import type { UndoOutcome } from '@harness/core';
import type { FnCtx, UndoCtx } from './ctx.ts';
import type { FnTypes, Outcome } from './fn.ts';

/** The implementation of a native fn. `undo` is required exactly when the fn declares an undo type. */
export type FnImpl<T extends FnTypes, Cfg = unknown> =
  { run(args: T['args'], ctx: FnCtx<T, Cfg>): Promise<Outcome<T>> } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx<Cfg>): Promise<UndoOutcome> });
