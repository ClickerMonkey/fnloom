/**
 * A fn's facts as people read them (`FnFacts` and its search hit): what it does to data in words, what a call costs
 * and how long it takes, the types it reads and writes, and its examples as text. Pure, so it is tested alone.
 */
import type { CostEstimate, FnExampleView, FnFacts, FnMode, Json, ReadablePayload, RunTimes } from '@harness/core';
import { z } from 'zod';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';

/** What each mode does to data, in plain words. */
export const MODE_WORDS = {
  read: { label: 'Reads', about: 'Only reads: nothing is changed.' },
  write: { label: 'Writes', about: 'Adds or changes things.' },
  delete: { label: 'Deletes', about: 'Can remove things.' },
} as const satisfies Record<FnMode, { label: string; about: string }>;

/** The tone of each mode's badge: the more it can do, the stronger. */
export const MODE_TONE = { read: 'neutral', write: 'warn', delete: 'danger' } as const satisfies Record<FnMode, 'neutral' | 'warn' | 'danger'>;

/** Where a cost estimate comes from, in words. */
const BASIS_WORDS = {
  free: 'Spends nothing',
  history: 'From its runs',
  payload: 'From the call and the model’s price',
  unknown: 'Spends, never run yet',
} as const satisfies Record<CostEstimate['basis'], string>;

/** One figure of the facts strip. */
export interface Figure {
  readonly key: 'cost' | 'time' | 'slow' | 'runs';
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

/** What a call costs in words: "Free", "$0.002", "$0.001–$0.01, typically $0.004". */
export function costText(cost: CostEstimate): string {
  if (cost.basis === 'free') { return 'Free'; }
  if (cost.basis === 'unknown') { return 'Unknown'; }
  if (cost.min === cost.max) { return formatCost(cost.typical); }
  return `${formatCost(cost.typical)} (${formatCost(cost.min)}–${formatCost(cost.max)})`;
}

/** The facts strip: cost, typical and slow time, and how many runs the numbers come from. */
export function factFigures(facts: Pick<FnFacts, 'cost' | 'times'>): Figure[] {
  const out: Figure[] = [{ key: 'cost', label: 'Cost a call', value: costText(facts.cost), detail: BASIS_WORDS[facts.cost.basis] }];
  const times: RunTimes | undefined = facts.times;
  if (times !== undefined && times.runs > 0) {
    out.push(
      { key: 'time', label: 'Typical time', value: formatDuration(times.typical), detail: 'The median run' },
      { key: 'slow', label: 'Slow runs', value: formatDuration(times.slow), detail: `Longest ${formatDuration(times.longest)}` },
    );
  }
  out.push({ key: 'runs', label: 'Runs', value: (times?.runs ?? facts.cost.runs).toLocaleString(), detail: 'Settled, all time' });
  return out;
}

/** A JSON value as compact, readable text for an example (pretty when it is short enough to read that way). */
export function jsonText(value: Json): string {
  const flat = JSON.stringify(value);
  return flat.length <= 80 ? flat : JSON.stringify(value, null, 2);
}

/** An example as a call: `bash({"command":"ls"})`. */
export function exampleCall(local: string, example: Pick<FnExampleView, 'args'>): string {
  return `${local}(${jsonText(example.args)})`;
}

/** How a kind fn's payload is shown: as its kind writes it for people (a query's SQL, a program), or as stored JSON. */
export const PayloadForm = z.enum(['readable', 'stored']);
export type PayloadForm = z.infer<typeof PayloadForm>;

/** A kind fn's payload as code to show: its readable form when it has one and that is picked, else the stored JSON. */
export function shownPayload(payload: Json | undefined, readable: ReadablePayload | undefined, form: PayloadForm): ReadablePayload | undefined {
  if (readable !== undefined && form === 'readable') { return readable; }
  return payload === undefined ? undefined : { language: 'json', code: JSON.stringify(payload, null, 2) };
}
