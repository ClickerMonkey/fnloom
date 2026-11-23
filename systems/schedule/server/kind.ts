/**
 * The `schedule/schedule` kind's check and describe (its run is the timer's `runFiring`):
 *
 * - **check**: the times of a day are at least the config's `minGap` apart (`gapProblems`), the target is a fn the
 *   owner may see, and the args program calls no fns and gives the target's args.
 * - **describe**: the schedule fn's own args are `{ at? }` ("run now" without it), its result is the target's, and
 *   its deps are the target (so the hub's rule "a fn the parent declares as a dep was reviewed with it" lets each firing
 *   call it, and the fn page shows what it runs) and `hub/fns_get` (the target's signature, read again when it runs).
 *   Its mode is the target's; its page shows the args program in gin, under the words it was written from.
 */
import { KindDescription, type KindFnShape } from '@harness/core';
import { hub, type KindCheckCtx } from '@harness/sdk';
import { kindCheckLookups } from '@harness/sdk/program';
import { gapProblems, type SchedulePayload } from '../shared/types.ts';
import { checkArgs, RUN_ARGS } from './args.ts';

/** The target fn's shape, or why there is none. */
async function targetOf(payload: SchedulePayload, ctx: KindCheckCtx): Promise<KindFnShape | undefined> {
  return await ctx.fn(payload.fn);
}

/** Problems with a schedule beyond its payload's type, in words (`minGap` is the config's, in ms). */
export async function scheduleProblems(payload: SchedulePayload, ctx: KindCheckCtx, minGap: number): Promise<string[]> {
  const problems = gapProblems(payload.when, minGap);
  const target = await targetOf(payload, ctx);
  if (target === undefined) {
    return [...problems, `${payload.fn} is not a fn its owner can run: check its name (as the tools spell it) and that they may use it.`];
  }
  const args = await checkArgs(payload.args, target, payload.fn, kindCheckLookups(ctx));
  return [...problems, ...args.problems];
}

/** A schedule fn's signature and facts, worked out from its payload. */
export async function describeSchedule(payload: SchedulePayload, ctx: KindCheckCtx): Promise<KindDescription> {
  const target = await targetOf(payload, ctx);
  const args = target === undefined ? undefined : await checkArgs(payload.args, target, payload.fn, kindCheckLookups(ctx));
  const asked = payload.argsAsked === undefined ? '' : `// ${payload.argsAsked.replace(/\n/g, '\n// ')}\n`;
  return KindDescription.parse({
    args: RUN_ARGS,
    returns: target?.returns ?? { name: 'any' },
    deps: [payload.fn, hub.fns.fns_get.name],
    operations: { cancel: true, pause: false, undo: false, background: true },
    // its own work is free; it does what its target does
    effects: { mode: target?.mode ?? 'write', free: true },
    examples: [{ args: {}, note: `Runs it now, outside its times: ${payload.fn} with the args worked out for this moment.` }],
    ...(args?.code === undefined ? {} : { readable: { language: 'gin', code: `${asked}// The args ${payload.fn} is called with:\n${args.code}` } }),
  });
}
