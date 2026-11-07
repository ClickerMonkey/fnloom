/**
 * Which run cards are collapsed. A card the person hasn't touched follows `collapsedByDefault`: open while it works,
 * waits on someone or failed, folded to its one line once it finished, so a finished turn reads as the answer and not
 * its fns' raw output. A card the person opened or folded keeps that choice, saved on this device by run id so a
 * reload keeps it. "Collapse all" writes each card's own choice; there is no separate mode. The newest choices are
 * kept, up to a cap.
 */
import { RunId, type RunStatus } from '@harness/core';
import type { Ref } from 'vue';
import { z } from 'zod';
import { persisted, type KeyValueStore } from '../../state/persisted.ts';

export const COLLAPSE_KEY = 'harness.runCards';
/** How many choices are remembered. */
export const COLLAPSE_KEEP = 500;

/** One saved choice: the run, and whether its card is collapsed. */
const Choice = z.tuple([RunId, z.boolean()]);

/** What a card's default needs to know about its run. */
export interface CollapsibleRun {
  readonly id: RunId;
  readonly status: RunStatus;
}

/** Whether an untouched card starts collapsed: only once its run finished well (or was undone). */
export function collapsedByDefault(run: CollapsibleRun): boolean {
  return run.status === 'done' || run.status === 'undone';
}

/** Collapsed and expanded run cards. */
export class CollapseStore {
  readonly #saved: Ref<ReadonlyArray<z.infer<typeof Choice>>>;

  constructor(store: KeyValueStore) {
    this.#saved = persisted(store, COLLAPSE_KEY, z.array(Choice), []);
  }

  /** The person's own choice for a card, if they made one. */
  choice(run: RunId): boolean | undefined {
    return this.#saved.value.find(([id]) => id === run)?.[1];
  }

  isCollapsed(run: CollapsibleRun): boolean {
    return this.choice(run.id) ?? collapsedByDefault(run);
  }

  set(run: RunId, collapsed: boolean): void {
    this.setAll([run], collapsed);
  }

  /** Collapse or expand several cards at once. */
  setAll(runs: readonly RunId[], collapsed: boolean): void {
    const changing = new Set(runs);
    const rest = this.#saved.value.filter(([id]) => !changing.has(id));
    this.#saved.value = [...rest, ...runs.map((id): z.infer<typeof Choice> => [id, collapsed])].slice(-COLLAPSE_KEEP);
  }
}
