/**
 * The parallel claims of an agent's calls (core `claims.ts`): what each call of one step operates on, and so which
 * earlier calls of the step it waits for. A call claims its fn's templates filled from its args
 * (`FnDecl.parallelClaims`), and, for a fn with `dynamicClaims`, what its system answers for the call (`claims` on the
 * system link). The rule is aeye's (`claimWaits`): a call whose claims conflict with an earlier call's waits until that
 * call has settled; the rest run together. An agent whose fn runs its tools one at a time (`toolExecution:
 * 'sequential'`) claims `*` for every call, so each waits for the one before.
 *
 * A call refused before it ran (invalid input, its args don't fit) takes no part: it neither waits nor holds anyone up.
 * A fn whose system can't be asked (it is gone, or its hook throws) claims `*` for the call, so a call that can't say
 * what it touches never runs beside another.
 */
import { ALL_CLAIMS, claimWaits, type ToolClaims } from '@aeye/core';
import { fillClaims, splitName, SystemName, type FnRecord, type Json, type RunId, type SessionId, type UserInfo } from '@harness/core';
import type { Logger } from '@ayepi/log';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import type { LinkService } from '../link/index.ts';
import { messageOf } from './errors.ts';

/** What working out claims uses. */
export interface ClaimsDeps {
  readonly catalog: Pick<Catalog, 'fn' | 'signature'>;
  readonly link: Pick<LinkService, 'connection'>;
  readonly log: Logger;
}

/** One call of a step, as the claims see it: a fn's call with its args, or a call refused before it ran (`fn` undefined). */
export interface ClaimingCall {
  readonly toolCallId: string;
  readonly fn: FnRecord['name'] | undefined;
  readonly args: Json;
}

/** Who made the step's calls. */
export interface ClaimingStep {
  readonly user: UserInfo;
  /** The agent run that made them. */
  readonly caller: RunId;
  readonly session: SessionId | undefined;
  /** The agent's fn runs its tools one at a time: every call claims `*`. */
  readonly sequential: boolean;
}

/**
 * For each call of a step, in the model's order, the tool call ids of the earlier calls it waits for. Claims are only
 * worked out when at least two calls take part, so a step of one call asks no system anything.
 */
export async function stepWaits(deps: ClaimsDeps, step: ClaimingStep, calls: readonly ClaimingCall[]): Promise<string[][]> {
  const fns = await Promise.all(calls.map((call) => takingPart(deps, call)));
  const taking = calls.flatMap((call, index) => {
    const fn = fns[index];
    return fn === undefined ? [] : [{ index, call, fn }];
  });
  const waits: string[][] = calls.map(() => []);
  if (taking.length < 2) return waits;
  const claims = await Promise.all(taking.map(async ({ call, fn }) => (step.sequential ? [ALL_CLAIMS] : callClaims(deps, step, fn, call.args))));
  claimWaits(claims).forEach((earlier, at) => {
    const entry = taking[at];
    if (entry !== undefined) waits[entry.index] = earlier.flatMap((index) => taking[index]?.call.toolCallId ?? []);
  });
  return waits;
}

/** The fn of a call that takes part in claims: one that exists and whose args fit it (anything else settles at once). */
async function takingPart(deps: ClaimsDeps, call: ClaimingCall): Promise<FnRecord | undefined> {
  if (call.fn === undefined) return undefined;
  const fn = await deps.catalog.fn(call.fn);
  if (fn === undefined) return undefined;
  try {
    return (await deps.catalog.signature(fn.name)).argsSchema.safeParse(call.args).success ? fn : undefined;
  } catch {
    // a fn whose signature doesn't resolve (its kind gone) is refused when it starts
    return undefined;
  }
}

/**
 * One call's claims: its fn's templates filled from its args, and for a fn with `dynamicClaims` what its system adds.
 * A system that can't be asked, or whose hook fails, makes the call claim `*`.
 */
export async function callClaims(deps: Pick<ClaimsDeps, 'link' | 'log'>, step: Omit<ClaimingStep, 'sequential'>, fn: FnRecord, args: Json): Promise<ToolClaims> {
  const filled = fillClaims(fn.decl.parallelClaims ?? [], args);
  if (fn.decl.dynamicClaims !== true) return filled;
  const alone = (why: string): ToolClaims => {
    deps.log.warn('agent.claims-unknown', { fn: fn.name, caller: step.caller, error: why });
    return [ALL_CLAIMS];
  };
  const connection = fn.system === HUB_SYSTEM ? undefined : deps.link.connection(SystemName.parse(fn.system));
  if (connection === undefined) return alone(`${fn.system} is not connected`);
  try {
    const answer = await connection.peer.call('claims', {
      fn: splitName(fn.name).local, args, user: step.user, caller: step.caller, ...(step.session === undefined ? {} : { session: step.session }),
    }, { signal: connection.signal });
    return [...new Set([...filled, ...answer.claims])];
  } catch (error) {
    return alone(messageOf(error));
  }
}
