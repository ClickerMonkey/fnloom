/** Pane widths for `UiSplitter`. */

/** A width kept between `min` and `max`, rounded to a whole pixel. */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

/** Which pane a `UiSplitter` sizes: the one before it (to its left) or the one after it (to its right). */
export type SplitSide = 'before' | 'after';

/**
 * A pane's width once its divider moved `by` px (right is positive): the pane before it grows as it moves right,
 * the pane after it as it moves left. Not yet kept within its limits.
 */
export function dragWidth(was: number, by: number, side: SplitSide): number {
  return side === 'before' ? was + by : was - by;
}
