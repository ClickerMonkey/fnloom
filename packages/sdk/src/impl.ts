/** The implementation shapes a system's server writes, computed from what its contract declares. */
import type { ToolClaims } from '@aeye/core';
import type { PreviewAnswer, SensitivityFlag, UndoOutcome } from '@harness/core';
import type { ClaimsCtx, FnCtx, Own, PreviewCtx, UndoCtx } from './ctx.ts';
import type { FnTypes, Outcome } from './fn.ts';

/**
 * The implementation of a native fn. `undo` is required exactly when the fn declares an undo type; `preview` when it
 * declares `approval` with a preview (checked when the system serves): what a run would do, or why it can't go ahead.
 * `flags` when it declares `flags: true`: the sensitive files a run with these args would read or write (empty when
 * none), asked by the hub before every run. `claims` when it declares `dynamicClaims: true`: what a call with these
 * args operates on (`file:/abs/path`, or `'*'` to run alone), asked by the hub before an agent's call starts, so calls
 * that clash run one after another.
 */
export type FnImpl<T extends FnTypes, Cfg = unknown, O extends Own = Own> =
  {
    run(args: T['args'], ctx: FnCtx<T, Cfg, O>): Promise<Outcome<T>>;
    preview?(args: T['args'], ctx: PreviewCtx<Cfg, O>): Promise<PreviewAnswer>;
    flags?(args: T['args'], ctx: PreviewCtx<Cfg, O>): Promise<SensitivityFlag[]>;
    claims?(args: T['args'], ctx: ClaimsCtx<Cfg, O>): ToolClaims | Promise<ToolClaims>;
  } &
  ([T['undo']] extends [never] ? { undo?: never } : { undo(payload: T['undo'], ctx: UndoCtx<Cfg>): Promise<UndoOutcome> });
