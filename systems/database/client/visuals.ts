/**
 * The result view's state: the visuals that fit a result (best first, the table last), which one is shown, and the
 * person's switch between them. The list comes from the client runtime's registry when the chat gives one (every
 * system's contributions), else from this system's own visuals. The choice lives in the view (per message), not the
 * URL: it is how this message is drawn, not a page.
 */
import type { ResultTable, VisualFit } from '@harness/core';
import type { VisualOption } from '@harness/sdk';
import { computed, ref, type Component, type Ref } from 'vue';
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

/** A visual the view can draw: its name and label, its fit, and its component with the props it is drawn with. */
export interface ShownVisual {
  readonly name: string;
  readonly label: string;
  readonly fit: VisualFit;
  readonly component: Component;
  /** Props the source gives it (a contributed visual's own system); the view adds the table and its own system. */
  readonly props: Readonly<Record<string, unknown>>;
}

/** The chat runtime's options (every loaded system's contributions, best first) as the view draws them. */
export function fromSource(options: readonly VisualOption[]): ShownVisual[] {
  return options.map((option) => ({ name: option.name, label: labelOf(option.name), fit: option.fit, component: option.component, props: { ...option.props } }));
}

/** This system's own visuals that fit, for a view the chat gives no source. */
export function fromOwn<V extends VisualMatch & { component: Component }>(table: ResultTable, visuals: Readonly<Record<string, V>>): ShownVisual[] {
  return fitting(table, visuals).map((entry) => ({ name: entry.name, label: entry.label, fit: entry.fit, component: entry.visual.component, props: {} }));
}

/** The view's choice: the visual shown (the person's pick, else the best) among the ones that fit, and the switch. */
export function useVisualChoice(options: Ref<readonly ShownVisual[]>): { shown: Ref<ShownVisual | undefined>; choose: (name: string) => void; chosen: Ref<string | undefined> } {
  const chosen = ref<string | undefined>();
  const shown = computed(() => options.value.find((option) => option.name === chosen.value) ?? options.value[0]);
  return { shown, chosen, choose: (name) => { chosen.value = name; } };
}
