/**
 * The rules behind `UiPicker`, the search-as-you-type multi-select every input that names things uses (fns, context,
 * systems, people, models, resources, types): where its options come from (`PickerSource`), what the list offers once
 * the picked values are left out, and how picking and removing change the values. Pure, so they are unit tested.
 */
import type { PickOption } from '@harness/core';

/** Where a picker's options come from. The app's sources ask the hub's `pick`; tests hand in a fixed list. */
export interface PickerSource {
  /** Options matching what is typed (all of the best when nothing is), best first. */
  search(text: string): Promise<readonly PickOption[]>;
  /** The options of values already picked, to label their chips (`missing` for a value that resolves to nothing). */
  label(values: readonly string[]): Promise<readonly PickOption[]>;
}

/** One row of the open list: an option, or the words as typed taken as a value (`custom`). */
export interface PickChoice {
  readonly option: PickOption;
  readonly custom: boolean;
}

/**
 * The rows the list shows: the options not already picked, then, when `custom` reads what is typed as a value that no
 * option has, that value ("Use fs/*").
 */
export function pickChoices(
  options: readonly PickOption[], picked: readonly string[], typed: string, custom?: (text: string) => string | undefined,
): PickChoice[] {
  const chosen = new Set(picked);
  const rows: PickChoice[] = options.filter((option) => !chosen.has(option.value)).map((option) => ({ option, custom: false }));
  const text = typed.trim();
  const own = text === '' || custom === undefined ? undefined : custom(text);
  if (own !== undefined && !chosen.has(own) && !options.some((option) => option.value === own)) {
    rows.push({ option: { value: own, label: own, hint: 'as typed' }, custom: true });
  }
  return rows;
}

/** The values once `value` is picked: it replaces the value of a single picker (`max` 1), else joins the end unless full or already there. */
export function withPicked(values: readonly string[], value: string, max: number | undefined): string[] {
  if (max === 1) { return [value]; }
  if (values.includes(value) || (max !== undefined && values.length >= max)) { return [...values]; }
  return [...values, value];
}

/** A single picker's value as its chips: none for blank. */
export function onePicked(value: string): string[] {
  return value === '' ? [] : [value];
}

/** The values without the one at `index`. */
export function withoutPicked(values: readonly string[], index: number): string[] {
  return values.filter((_, i) => i !== index);
}

/** The active row after an arrow key: down (`1`) or up (`-1`), wrapping; 0 when the list is empty. */
export function stepActive(active: number, count: number, step: 1 | -1): number {
  return count === 0 ? 0 : (active + step + count) % count;
}

/** A picker over a fixed list (a test's, or options the page already has): matches by label, value or hint. */
export function listSource(options: readonly PickOption[]): PickerSource {
  return {
    search: (text) => {
      const words = text.trim().toLowerCase();
      return Promise.resolve(options.filter((o) => words === '' || [o.value, o.label, o.hint ?? ''].some((s) => s.toLowerCase().includes(words))));
    },
    label: (values) => Promise.resolve(values.map((value) => options.find((o) => o.value === value) ?? { value, label: value, missing: true })),
  };
}
