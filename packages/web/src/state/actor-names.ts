/**
 * People's names for actor ids shown on a page (who changed a record, who made a version), asked of the hub's
 * `pick` (the `person` source) once per new set of ids. Until the hub answers, and for an id it cannot name for this
 * viewer, the id itself is the name.
 */
import { ref, watch, type Ref } from 'vue';
import type { PickerSource } from '../ui/picker.ts';

/** The name of an actor id: the person's name once known, else the id. */
export type NameOf = (actor: string) => string;

/** Names for the ids `ids` returns, looked up through `people` whenever the set of ids changes. */
export function useActorNames(people: PickerSource, ids: () => readonly string[]): { readonly nameOf: NameOf; readonly names: Readonly<Ref<ReadonlyMap<string, string>>> } {
  const names = ref<ReadonlyMap<string, string>>(new Map());
  watch(() => [...new Set(ids())].sort().join('\n'), async (key) => {
    const wanted = key === '' ? [] : key.split('\n').filter((id) => !names.value.has(id));
    if (wanted.length === 0) { return; }
    try {
      const options = await people.label(wanted);
      const next = new Map(names.value);
      for (const option of options) { if (option.missing !== true) { next.set(option.value, option.label); } }
      names.value = next;
    } catch {
      // the ids stay as they are; a name is a nicety, never a reason to fail the page
    }
  }, { immediate: true });
  return { nameOf: (actor) => names.value.get(actor) ?? actor, names };
}
