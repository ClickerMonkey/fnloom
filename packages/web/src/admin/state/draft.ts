/**
 * A form's draft held as one immutable value (`defineModel`), and each of its fields as a ref the inputs bind to:
 * reading gives the field, writing replaces the draft with that field changed.
 */
import { computed, type Ref, type WritableComputedRef } from 'vue';

/** The fields of a draft, each bound to the draft's ref. */
export function draftFields<T extends object>(draft: Ref<T>): <K extends keyof T>(key: K) => WritableComputedRef<T[K]> {
  return (key) => computed({ get: () => draft.value[key], set: (next) => { draft.value = { ...draft.value, [key]: next }; } });
}
