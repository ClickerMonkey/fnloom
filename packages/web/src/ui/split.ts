/** Pane widths for `UiSplitter`. */

/** A width kept between `min` and `max`, rounded to a whole pixel. */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}
