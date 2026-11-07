/**
 * Where a floating panel (popover, menu) goes next to its anchor. Pure, so it is tested without a browser.
 *
 * The panel keeps its natural size when it fits; otherwise it is capped to the viewport (less a margin) and scrolls
 * inside. It flips to the other side of the anchor when that side has more room, and slides along the anchor to stay
 * on screen.
 */

/** A side of the anchor the panel opens on. */
export type Side = 'top' | 'bottom' | 'left' | 'right';
/** How the panel lines up with the anchor along that side. */
export type Align = 'start' | 'center' | 'end';

/** A box on screen, in viewport px. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A size in px. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** What the caller wants. */
export interface PlaceOptions {
  readonly side: Side;
  readonly align: Align;
  /** Gap between the anchor and the panel. */
  readonly offset: number;
  /** Space kept between the panel and the viewport's edges. */
  readonly margin: number;
}

/** Where the panel goes, and the most room it may take. */
export interface Placement {
  readonly left: number;
  readonly top: number;
  /** The side it ended up on, after any flip. */
  readonly side: Side;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** Sensible defaults: below, lined up with the anchor's start. */
export const DEFAULT_PLACEMENT: PlaceOptions = { side: 'bottom', align: 'start', offset: 6, margin: 8 };

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const satisfies Record<Side, Side>;

/** One axis of the problem: the anchor's start and length on it, the panel's length, the viewport's length. */
interface Axis {
  readonly start: number;
  readonly length: number;
  readonly panel: number;
  readonly viewport: number;
}

/** Room on the before and after sides of the anchor along the main axis. */
function room(axis: Axis, options: PlaceOptions): { before: number; after: number } {
  return {
    before: axis.start - options.offset - options.margin,
    after: axis.viewport - (axis.start + axis.length) - options.offset - options.margin,
  };
}

/** Position along the cross axis: aligned to the anchor, then slid to stay inside the viewport. */
function cross(axis: Axis, align: Align, margin: number): { position: number; max: number } {
  const max = Math.max(0, axis.viewport - margin * 2);
  const length = Math.min(axis.panel, max);
  const wanted = align === 'start' ? axis.start : align === 'end' ? axis.start + axis.length - length : axis.start + (axis.length - length) / 2;
  const position = Math.min(Math.max(wanted, margin), axis.viewport - margin - length);
  return { position: Math.max(position, margin), max };
}

/** Place a panel of `panel` size next to `anchor` inside `viewport`. */
export function place(anchor: Box, panel: Size, viewport: Size, options: PlaceOptions = DEFAULT_PLACEMENT): Placement {
  const vertical = options.side === 'top' || options.side === 'bottom';
  const main: Axis = vertical
    ? { start: anchor.top, length: anchor.height, panel: panel.height, viewport: viewport.height }
    : { start: anchor.left, length: anchor.width, panel: panel.width, viewport: viewport.width };
  const other: Axis = vertical
    ? { start: anchor.left, length: anchor.width, panel: panel.width, viewport: viewport.width }
    : { start: anchor.top, length: anchor.height, panel: panel.height, viewport: viewport.height };

  const space = room(main, options);
  const wantsAfter = options.side === 'bottom' || options.side === 'right';
  const preferred = wantsAfter ? space.after : space.before;
  const alternative = wantsAfter ? space.before : space.after;
  const flip = main.panel > preferred && alternative > preferred;
  const after = flip ? !wantsAfter : wantsAfter;
  const side = flip ? OPPOSITE[options.side] : options.side;

  const mainMax = Math.max(0, after ? space.after : space.before);
  const mainLength = Math.min(main.panel, mainMax);
  const mainPosition = after ? main.start + main.length + options.offset : main.start - options.offset - mainLength;
  const crossed = cross(other, options.align, options.margin);

  return vertical
    ? { left: crossed.position, top: mainPosition, side, maxWidth: crossed.max, maxHeight: mainMax }
    : { left: mainPosition, top: crossed.position, side, maxWidth: mainMax, maxHeight: crossed.max };
}
