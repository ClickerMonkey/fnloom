/**
 * Keeping a page alive: run `refresh` every `every` ms while the component is mounted and the page is in view, and
 * once more as soon as it comes back into view.
 */
import { onBeforeUnmount, onMounted } from 'vue';

export function useLive(refresh: () => void, every: number): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const visible = (): boolean => document.visibilityState !== 'hidden';
  const onVisibility = (): void => { if (visible()) { refresh(); } };
  onMounted(() => {
    timer = setInterval(() => { if (visible()) { refresh(); } }, every);
    document.addEventListener('visibilitychange', onVisibility);
  });
  onBeforeUnmount(() => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
