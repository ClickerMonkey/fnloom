/** The current time as a ref that ticks, so relative times ("5m") stay true while a page is open. */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** The time now, updated every `every` ms while the component is mounted. */
export function useNow(every = 30_000): Readonly<Ref<number>> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, every); });
  onBeforeUnmount(() => { clearInterval(timer); });
  return now;
}
