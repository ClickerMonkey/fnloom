/**
 * The result view's state: the visuals that fit a result (best first, the table last), which one is shown, and the
 * person's switch between them. The list comes from the client runtime's registry when the chat gives one (every
 * system's contributions), else from this system's own visuals. The choice lives in the view (per message), not the
 * URL: it is how this message is drawn, not a page.
 */
import type { ResultTable, VisualFit } from '@harness/core';
import { computed, ref, type Ref } from 'vue';
import { database } from '../shared/index.ts';

/** A visual's match logic: whether a result fits it, and how well. */
export interface VisualMatch {
  match(table: ResultTable): VisualFit;
}

/** A visual that fits a result, with its entry (its component, for the view). */
export interface FittingVisual<V extends VisualMatch> {
  readonly name: string;
  readonly label: string;
  readonly fit: VisualFit;
  readonly visual: V;
}

/** A visual's label, as the contract's `contributes` names it. */
export function labelOf(name: string): string {
  return database.contributes.find((entry) => entry.name === name)?.label ?? name;
}

/** The visuals that fit a table, best first; the table always fits and comes last among equals. */
export function fitting<V extends VisualMatch>(table: ResultTable, visuals: Readonly<Record<string, V>>): FittingVisual<V>[] {
  const fits: FittingVisual<V>[] = [];
  for (const [name, visual] of Object.entries(visuals)) {
    const fit = visual.match(table);
    if (fit.fits) { fits.push({ name, label: labelOf(name), fit, visual }); }
  }
  return fits.sort((a, b) => b.fit.score - a.fit.score || (a.name === 'table' ? 1 : b.name === 'table' ? -1 : 0));
}

/** The view's choice: the visuals that fit, the one shown (the person's pick, else the best), and the switch. */
export function useVisualChoice<V extends VisualMatch>(table: Ref<ResultTable>, visuals: Readonly<Record<string, V>>): { options: Ref<FittingVisual<V>[]>; shown: Ref<FittingVisual<V> | undefined>; choose: (name: string) => void; chosen: Ref<string | undefined> } {
  const chosen = ref<string | undefined>();
  const options = computed(() => fitting(table.value, visuals));
  const shown = computed(() => options.value.find((option) => option.name === chosen.value) ?? options.value[0]);
  return { options, shown, chosen, choose: (name) => { chosen.value = name; } };
}
