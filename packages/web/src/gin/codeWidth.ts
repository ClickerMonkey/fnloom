/**
 * How many characters of code fit across a box, kept up to date as it resizes: the box's width over the width of a
 * monospace probe of ten characters, less `margin`, between 24 and `CODE_WIDTH`. A phone wraps code sooner than a
 * desktop. Used by the code view and the expression editor.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import { CODE_WIDTH } from './logic/layout.ts';

/** The characters that fit across `root`, measured with `probe` (ten monospace characters). */
export function useCodeWidth(root: Ref<HTMLElement | null>, probe: Ref<HTMLElement | null>, margin = 3): Ref<number> {
  const width = ref(CODE_WIDTH);
  let observer: ResizeObserver | undefined;
  function measure(): void {
    const char = (probe.value?.getBoundingClientRect().width ?? 0) / 10;
    const box = root.value?.clientWidth ?? 0;
    if (char > 0 && box > 0) { width.value = Math.max(24, Math.min(CODE_WIDTH, Math.floor(box / char) - margin)); }
  }
  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== 'undefined' && root.value) { observer = new ResizeObserver(measure); observer.observe(root.value); }
  });
  onBeforeUnmount(() => observer?.disconnect());
  return width;
}
