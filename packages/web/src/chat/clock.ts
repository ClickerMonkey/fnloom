/**
 * The chat's clock: ticks every second while something is running (elapsed times count up), and every half minute
 * otherwise (relative times like "5m" stay true), so an idle thread doesn't redraw every second.
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

/** How often the clock ticks, fast and slow, in ms. */
export const TICK = { fast: 1_000, slow: 30_000 } as const;

/** The time now, ticking fast while `fast()` is true. */
export function useTicker(fast: () => boolean, clock: () => number = Date.now): Readonly<Ref<number>> {
  const now = ref(clock());
  let timer: ReturnType<typeof setInterval> | undefined;
  const arm = (): void => {
    clearInterval(timer);
    now.value = clock();
    timer = setInterval(() => { now.value = clock(); }, fast() ? TICK.fast : TICK.slow);
  };
  onMounted(arm);
  watch(fast, arm);
  onBeforeUnmount(() => { clearInterval(timer); });
  return now;
}
