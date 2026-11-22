/**
 * Tool names in stored model calls read back to fns, for the LLM call view and the run inspector (display only). Most
 * read back by core's rule (`fnOfStoredToolName`, which also reads the legacy spelling of old records); a name cut to
 * 64 characters (`…_x1a2b3c4d`) can't, so the hub's registry is asked for it once (`fnsOfModelNames`), and the answer
 * kept for the rest of the visit.
 */
import { fnOfStoredToolName, looksCut, type QualifiedName } from '@harness/core';
import { shallowRef } from 'vue';
import type { FnsApi } from '../api.ts';

/** The model names the hub read back so far. */
export class ModelNamesStore {
  readonly #api: Pick<FnsApi, 'fnsOfModelNames'>;
  /** Cut names the hub read back, and those it said mean none (absent from the answer). */
  readonly known = shallowRef<ReadonlyMap<string, QualifiedName>>(new Map());
  readonly #asked = new Set<string>();

  constructor(api: Pick<FnsApi, 'fnsOfModelNames'>) {
    this.#api = api;
  }

  /** The fn a stored tool name means (undefined for a static tool, or a cut name not read back yet). */
  fnOf(name: string): QualifiedName | undefined {
    return fnOfStoredToolName(name, (cut) => this.known.value.get(cut));
  }

  /** Ask the hub, once, for the cut names among these. */
  async resolve(names: readonly string[]): Promise<void> {
    const wanted = [...new Set(names)].filter((name) => looksCut(name) && !this.#asked.has(name));
    if (wanted.length === 0) { return; }
    for (const name of wanted) { this.#asked.add(name); }
    try {
      const found = await this.#api.fnsOfModelNames.call({ names: wanted });
      this.known.value = new Map([...this.known.value, ...Object.entries(found)]);
    } catch {
      // the pill falls back to the raw name; asking again on the next view is harmless
      for (const name of wanted) { this.#asked.delete(name); }
    }
  }
}
