/**
 * The systems a turn found held for review: every place the hub refuses a fn to the model says what blocks it as a
 * structured `FnBlock` (`hub/fns_load` and `hub/load` in `refused`, `hub/ctx_load` in `fnsRefused`, `hub/fns_search`
 * on each hit and `hub/fns_get` as `blocked`), and a direct call of a blocked fn (a tool, a static `run`) is kept as a
 * run settled invalid-input with that same block (`InvalidInput.blocked`). A block with code `held` means the fn's
 * system has changes (or a whole install) waiting for an admin's review. The chat shows one banner per held system on
 * that turn, from these runs alone. Pure, so it is tested alone.
 */
import { FnBlock, FnRefusal, FnSearchHit, LoadContextResult, NameRefusal, type Json, type SystemName } from '@harness/core';
import { hub } from '@harness/sdk';
import { z } from 'zod';
import type { RunView } from './runs.ts';

/** What blocks one name the model asked for: the hub's block, with the name. */
type Blocked = FnBlock & { readonly name: string };

/** A system the turn found held for review, with the fns of it the model was refused, in the order it met them. */
export interface HeldSystem {
  readonly system: SystemName;
  readonly fns: readonly string[];
}

/** Read the blocks out of one hub fn's result by its own result schema; a result of another shape blocks nothing. */
function reader<T>(schema: z.ZodType<T>, blocks: (result: T) => readonly Blocked[]): (result: Json) => readonly Blocked[] {
  return (result) => {
    const parsed = schema.safeParse(result);
    return parsed.success ? blocks(parsed.data) : [];
  };
}

/** The hub fns whose results carry blocks, and where in each result they are. */
const BLOCKS_BY_FN: ReadonlyMap<string, (result: Json) => readonly Blocked[]> = new Map([
  [hub.fns.fns_load.name, reader(z.object({ refused: z.array(FnRefusal) }), (r) => r.refused.map(({ fn, ...block }) => ({ ...block, name: fn })))],
  [hub.fns.load.name, reader(z.object({ refused: z.array(NameRefusal) }), (r) => r.refused)],
  [hub.fns.ctx_load.name, reader(LoadContextResult.pick({ fnsRefused: true }), (r) => r.fnsRefused.map(({ fn, ...block }) => ({ ...block, name: fn })))],
  [hub.fns.fns_get.name, reader(z.object({ fn: z.string(), blocked: FnBlock.optional() }), (r) => (r.blocked === undefined ? [] : [{ ...r.blocked, name: r.fn }]))],
  [hub.fns.fns_search.name, reader(z.object({ items: z.array(FnSearchHit.pick({ name: true, blocked: true })) }), (r) => r.items.flatMap((hit) => (hit.blocked === undefined ? [] : [{ ...hit.blocked, name: hit.name }])))],
]);

/**
 * The blocks one run says: a hub fn that refuses and finished, by its result; a call the hub refused because its fn is
 * blocked, by its refused input's block (the fn is the run's own).
 */
export function runBlocks(run: Pick<RunView, 'fn' | 'outcome'>): readonly Blocked[] {
  const { outcome } = run;
  if (outcome?.status === 'invalid-input') return outcome.invalid.blocked === undefined ? [] : [{ ...outcome.invalid.blocked, name: run.fn }];
  const read = BLOCKS_BY_FN.get(run.fn);
  return read === undefined || outcome?.status !== 'done' ? [] : read(outcome.result);
}

/** The systems a turn's runs found held for review, one entry each, in the order the runs met them. */
export function heldSystems(runs: readonly Pick<RunView, 'fn' | 'outcome'>[]): HeldSystem[] {
  const held = new Map<SystemName, Set<string>>();
  for (const block of runs.flatMap(runBlocks)) {
    if (block.code !== 'held' || block.system === undefined) { continue; }
    const fns = held.get(block.system) ?? new Set<string>();
    held.set(block.system, fns.add(block.name));
  }
  return [...held].map(([system, fns]) => ({ system, fns: [...fns] }));
}

/** The banner's words for a held system: "database has changes waiting for review". */
export function heldLine(held: Pick<HeldSystem, 'system'>): string {
  return `${held.system} has changes waiting for review`;
}

/** The words after the fns the turn was refused (the banner names them as pills): "is off until then.", "are …". */
export function heldTail(held: Pick<HeldSystem, 'fns'>): string {
  return `${held.fns.length === 1 ? 'is' : 'are'} off until then.`;
}

/** The words before the fn at `index` of `count` in a list read out: '', ', ' or ' and '. */
export function listJoin(index: number, count: number): string {
  return index === 0 ? '' : index === count - 1 ? ' and ' : ', ';
}
