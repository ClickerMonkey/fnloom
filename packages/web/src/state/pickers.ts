/**
 * The pickers' sources: one per kind of thing (`PickSource`), each asking the hub's `pick` for what is typed and for
 * the labels of values already picked. The hub answers only with what the asker may see. `people()` searches people
 * and groups together, for sharing.
 */
import type { PickOption, PickSource } from '@harness/core';
import type { PickerApi } from '../api/pickers.ts';
import type { PickerSource } from '../ui/picker.ts';

/** How many options a picker's list shows. */
export const PICK_LIMIT = 12;

/** Every picker's source, made once per kind. */
export class PickerStore {
  readonly #api: Pick<PickerApi, 'pick'>;
  readonly #sources = new Map<PickSource, PickerSource>();
  #people: PickerSource | undefined;

  constructor(api: Pick<PickerApi, 'pick'>) {
    this.#api = api;
  }

  /** The source of one kind of thing. */
  source(source: PickSource): PickerSource {
    const known = this.#sources.get(source);
    if (known !== undefined) { return known; }
    const made: PickerSource = {
      search: async (text) => this.#api.pick.call({ source, limit: PICK_LIMIT, ...(text === '' ? {} : { text }) }),
      label: async (values) => (values.length === 0 ? [] : this.#api.pick.call({ source, values: [...values] })),
    };
    this.#sources.set(source, made);
    return made;
  }

  /** People and groups together (sharing with either), people first. */
  people(): PickerSource {
    if (this.#people !== undefined) { return this.#people; }
    const person = this.source('person');
    const group = this.source('group');
    this.#people = {
      search: async (text) => (await Promise.all([person.search(text), group.search(text)])).flat(),
      label: async (values) => mergeLabels(values, await Promise.all([person.label(values), group.label(values)])),
    };
    return this.#people;
  }
}

/** One option per value from several sources' labels: the first that resolves, else a missing one. */
export function mergeLabels(values: readonly string[], answers: readonly (readonly PickOption[])[]): PickOption[] {
  const all = answers.flat();
  return values.map((value) => all.find((o) => o.value === value && o.missing !== true) ?? { value, label: value, missing: true });
}
