/**
 * The bash card's "Run again": starts a new `bash` run with the same args through the hub, as `!fs/bash` would. The
 * new run has its own card in the chat, with its approval, live status, cost, place in the fn tree and undo, and the
 * hub keeps it, so a reload shows it like any other run. State lives here, not in the component, so the card only
 * draws it.
 */
import type { RunId } from '@harness/core';
import { computed, ref, type ComputedRef, type Ref } from 'vue';

/** A "Run again" in progress or finished. */
export interface Rerun {
  /** The run it started, once the hub has started it. */
  readonly started: Ref<RunId | undefined>;
  /** Why it couldn't start, if it couldn't. */
  readonly error: Ref<string | undefined>;
  /** True from pressing until the hub has answered. */
  readonly busy: ComputedRef<boolean>;
  run(): void;
}

/** Start runs with `start`. Only one start is in flight at a time. */
export function useRerun(start: () => Promise<RunId>): Rerun {
  const started = ref<RunId>();
  const error = ref<string>();
  const pending = ref(false);
  const run = () => {
    if (pending.value) { return; }
    pending.value = true;
    error.value = undefined;
    start()
      .then((id) => { started.value = id; })
      .catch((problem: unknown) => { started.value = undefined; error.value = problem instanceof Error ? problem.message : 'It could not start.'; })
      .finally(() => { pending.value = false; });
  };
  return { started, error, busy: computed(() => pending.value), run };
}
