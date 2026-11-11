/**
 * Which ends of a sideways-scrolling strip (tabs, a nav) have more beyond them, so the strip can fade there: a strip
 * cut at its edge with the scrollbar hidden otherwise gives no sign that it scrolls. Pair the element with the
 * `edge-fade` class (`styles/base.css`) and bind `edges.value` to its `data-more` attribute.
 */
import { onBeforeUnmount, shallowRef, watch, type Ref, type ShallowRef } from 'vue';

/** The ends of a strip with more beyond them: '' for none, else 'start', 'end' or 'both'. */
export type MoreEdges = '' | 'start' | 'end' | 'both';

/** The ends of a strip with more beyond them, from its scroll position and sizes (a pixel of slack for rounding). */
export function moreEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): MoreEdges {
  const start = scrollLeft > 1;
  const end = scrollLeft + clientWidth < scrollWidth - 1;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : '';
}

/** The ends of `strip` with more beyond them, kept current as it scrolls, resizes or its content changes. */
export function useMoreEdges(strip: Ref<HTMLElement | null>): Readonly<ShallowRef<MoreEdges>> {
  const edges = shallowRef<MoreEdges>('');
  let sizer: ResizeObserver | undefined;
  let watcher: MutationObserver | undefined;
  let current: HTMLElement | null = null;
  const measure = (): void => {
    if (current !== null) { edges.value = moreEdges(current.scrollLeft, current.clientWidth, current.scrollWidth); }
  };
  const release = (): void => {
    current?.removeEventListener('scroll', measure);
    sizer?.disconnect();
    watcher?.disconnect();
  };
  watch(strip, (el) => {
    release();
    current = el;
    if (el === null) { return; }
    el.addEventListener('scroll', measure, { passive: true });
    if (typeof ResizeObserver !== 'undefined') { sizer = new ResizeObserver(measure); sizer.observe(el); }
    if (typeof MutationObserver !== 'undefined') { watcher = new MutationObserver(measure); watcher.observe(el, { childList: true, subtree: true, characterData: true }); }
    measure();
  }, { immediate: true, flush: 'post' });
  onBeforeUnmount(release);
  return edges;
}

/** Whether a box cut to its height holds more than it shows (a pixel of slack for rounding). */
export function isClipped(clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}

/**
 * Whether `box` (cut to its height with `overflow: hidden`, never scrolled) holds more than it shows, kept current as
 * it or its content resizes or its content changes: the box can then fade its foot and offer the whole of it elsewhere.
 */
export function useClipped(box: Ref<HTMLElement | null>): Readonly<ShallowRef<boolean>> {
  const clipped = shallowRef(false);
  let sizer: ResizeObserver | undefined;
  let watcher: MutationObserver | undefined;
  let current: HTMLElement | null = null;
  const measure = (): void => {
    if (current !== null) { clipped.value = isClipped(current.clientHeight, current.scrollHeight); }
  };
  const observeContent = (): void => {
    if (sizer === undefined || current === null) { return; }
    sizer.disconnect();
    sizer.observe(current);
    for (const child of current.children) { sizer.observe(child); }
  };
  const release = (): void => {
    sizer?.disconnect();
    watcher?.disconnect();
    sizer = undefined;
    watcher = undefined;
  };
  watch(box, (el) => {
    release();
    current = el;
    if (el === null) { return; }
    if (typeof ResizeObserver !== 'undefined') { sizer = new ResizeObserver(measure); observeContent(); }
    if (typeof MutationObserver !== 'undefined') {
      watcher = new MutationObserver(() => { observeContent(); measure(); });
      watcher.observe(el, { childList: true, subtree: true, characterData: true });
    }
    measure();
  }, { immediate: true, flush: 'post' });
  onBeforeUnmount(release);
  return clipped;
}
