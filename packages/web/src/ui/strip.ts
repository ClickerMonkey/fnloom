/**
 * Scroll math for a sideways strip with its scrollbar hidden (`UiTabs`): a vertical mouse wheel moves it sideways,
 * its edge arrows page it, and the chosen item is kept in view clear of those arrows. Pure, so it is tested alone.
 */

/** A strip's scroll position and sizes, in px. */
export interface StripBox {
  readonly scrollLeft: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
}

/** The part of a `WheelEvent` the strip reads. */
export interface WheelDelta {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (`WheelEvent.DOM_DELTA_*`). */
  readonly deltaMode: number;
  readonly ctrlKey?: boolean;
}

/** A wheel line in px, for mice that report lines (Firefox). */
export const WHEEL_LINE = 16;
/** How much of the strip's width an edge arrow pages by. */
export const ARROW_PAGE = 0.8;
/** The room an edge arrow takes at each end, which a revealed item stays clear of, in px. */
export const ARROW_ROOM = 32;

/** The furthest the strip scrolls. */
function maxScroll(box: StripBox): number {
  return Math.max(0, box.scrollWidth - box.clientWidth);
}

/** A position kept within the strip's scroll range. */
function within(left: number, box: StripBox): number {
  return Math.min(Math.max(left, 0), maxScroll(box));
}

/**
 * Where a vertical wheel turn moves the strip, or undefined to leave the wheel alone: a sideways wheel or trackpad
 * swipe (the browser already scrolls it), a pinch-zoom (ctrl), a strip that fits, or one already at the end the wheel
 * pushes towards (so the page around it scrolls on).
 */
export function wheelScroll(delta: WheelDelta, box: StripBox): number | undefined {
  if (delta.ctrlKey === true || Math.abs(delta.deltaY) <= Math.abs(delta.deltaX)) { return undefined; }
  const by = delta.deltaY * (delta.deltaMode === 1 ? WHEEL_LINE : delta.deltaMode === 2 ? box.clientWidth : 1);
  const next = within(box.scrollLeft + by, box);
  return Math.abs(next - box.scrollLeft) < 1 ? undefined : next;
}

/** Where an edge arrow moves the strip: most of a strip's width towards its start (-1) or end (1). */
export function arrowScroll(direction: -1 | 1, box: StripBox): number {
  return within(box.scrollLeft + direction * Math.max(1, Math.round(box.clientWidth * ARROW_PAGE)), box);
}

/**
 * Where the strip scrolls to show an item (`left` and `width` within the strip's content), clear of the edge
 * arrows; unchanged when it already shows. An item wider than the room shows from its start.
 */
export function revealScroll(item: { readonly left: number; readonly width: number }, box: StripBox, room = ARROW_ROOM): number {
  const start = item.left - room;
  const end = item.left + item.width + room - box.clientWidth;
  if (start < box.scrollLeft) { return within(start, box); }
  if (end > box.scrollLeft) { return within(Math.min(end, start), box); }
  return box.scrollLeft;
}
