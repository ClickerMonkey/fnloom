/**
 * How wide a visual is drawn, followed live: product's phone rules key on the visual's own width (a chart in a narrow
 * chat pane is a phone chart), not the viewport's. Also the hook a chart hands its image export to the result view by.
 */
import { onBeforeUnmount, onMounted, ref, type InjectionKey, type Ref } from 'vue';

/** Below this width a visual follows the phone rules: legends at the bottom, tables as cards, no zoom slider. */
export const PHONE_WIDTH = 600;

/** An element's width, updated as it resizes (0 until mounted, and where there is no `ResizeObserver`). */
export function useWidth(element: Readonly<Ref<HTMLElement | null>>): Readonly<Ref<number>> {
  const width = ref(0);
  let observer: ResizeObserver | undefined;
  onMounted(() => {
    const el = element.value;
    if (el === null) { return; }
    width.value = el.clientWidth;
    if (typeof ResizeObserver === 'undefined') { return; }
    observer = new ResizeObserver(([entry]) => { if (entry !== undefined) { width.value = entry.contentRect.width; } });
    observer.observe(el);
  });
  onBeforeUnmount(() => { observer?.disconnect(); });
  return width;
}

/** An image of what a visual draws, as a data URL. */
export type ImageKind = 'png' | 'svg';
export type ImageExport = (kind: ImageKind) => string;

/** Where a result view lets the visual it draws offer an image export (a chart sets it while mounted). */
export interface ImageSlot {
  set(exporter: ImageExport | undefined): void;
}
export const IMAGE_SLOT: InjectionKey<ImageSlot> = Symbol('visual-image');
