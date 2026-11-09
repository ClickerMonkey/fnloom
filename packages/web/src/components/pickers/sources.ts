/**
 * The pickers' sources as components reach them: the app's (`PickerStore`, asking the hub), or, mounted outside the
 * app (a component alone in a test), sources with nothing to offer that still keep what is typed.
 */
import type { PickSource } from '@harness/core';
import { useStoresIfAny } from '../../state/stores.ts';
import { listSource, type PickerSource } from '../../ui/picker.ts';

/** Where a component's pickers get their options. */
export interface PickerSources {
  source(source: PickSource): PickerSource;
  /** People and groups together, for sharing. */
  people(): PickerSource;
}

const NOTHING: PickerSources = { source: () => listSource([]), people: () => listSource([]) };

/** The app's picker sources, or empty ones outside the app. */
export function usePickerSources(): PickerSources {
  return useStoresIfAny()?.chat.pickers ?? NOTHING;
}
