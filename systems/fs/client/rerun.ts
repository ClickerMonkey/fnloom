/**
 * The bash card's "run again": sends the `rerun` action through the hub and follows its delivery. State lives here,
 * not in the component, so the card only draws it.
 */
import type { Delivery } from '@harness/sdk';
import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue';
import type { CommandOutput } from '../shared/index.ts';

/** A rerun in progress or finished. */
export interface Rerun {
  /** The latest delivery, live. */
  readonly delivery: ShallowRef<Delivery<CommandOutput> | undefined>;
  readonly result: Ref<CommandOutput | undefined>;
  readonly error: Ref<string | undefined>;
  /** True from sending until the system has handled it. */
  readonly busy: ComputedRef<boolean>;
  run(): void;
}

/** Follow reruns sent by `send`. Only one runs at a time. */
export function useRerun(send: () => Delivery<CommandOutput>): Rerun {
  const delivery = shallowRef<Delivery<CommandOutput>>();
  const result = ref<CommandOutput>();
  const error = ref<string>();
  const pending = ref(false);
  const run = () => {
    if (pending.value) { return; }
    pending.value = true;
    result.value = undefined;
    error.value = undefined;
    const sent = send();
    delivery.value = sent;
    sent.result
      .then((output) => { if (delivery.value === sent) { result.value = output; } })
      .catch((problem: unknown) => { if (delivery.value === sent) { error.value = problem instanceof Error ? problem.message : 'It could not run.'; } })
      .finally(() => { pending.value = false; });
  };
  return { delivery, result, error, busy: computed(() => pending.value), run };
}
