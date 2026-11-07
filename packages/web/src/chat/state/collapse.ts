/**
 * Which run cards are collapsed, saved on this device by run id, so a reload keeps them. "Collapse all" writes each
 * card's own state; there is no separate mode. The newest choices are kept, up to a cap.
 */
import { RunId } from '@harness/core';
import type { Ref } from 'vue';
import { z } from 'zod';
import { persisted, type KeyValueStore } from '../../state/persisted.ts';

export const COLLAPSE_KEY = 'harness.collapsed';
/** How many collapsed cards are remembered. */
export const COLLAPSE_KEEP = 500;

/** Collapsed run cards. */
export class CollapseStore {
  readonly #saved: Ref<readonly RunId[]>;

  constructor(store: KeyValueStore) {
    this.#saved = persisted(store, COLLAPSE_KEY, z.array(RunId), []);
  }

  isCollapsed(run: RunId): boolean {
    return this.#saved.value.includes(run);
  }

  set(run: RunId, collapsed: boolean): void {
    this.setAll([run], collapsed);
  }

  /** Collapse or expand several cards at once. */
  setAll(runs: readonly RunId[], collapsed: boolean): void {
    const changing = new Set(runs);
    const rest = this.#saved.value.filter((id) => !changing.has(id));
    this.#saved.value = (collapsed ? [...rest, ...runs] : rest).slice(-COLLAPSE_KEEP);
  }
}
