/** Arrow-key movement through a list of items (tabs, radio options, menu items), shared by every such component. */

/** Which arrow keys move: left/right, up/down, or both. */
export type Orientation = 'horizontal' | 'vertical' | 'both';

const FORWARD = { horizontal: ['ArrowRight'], vertical: ['ArrowDown'], both: ['ArrowRight', 'ArrowDown'] } as const satisfies Record<Orientation, readonly string[]>;
const BACKWARD = { horizontal: ['ArrowLeft'], vertical: ['ArrowUp'], both: ['ArrowLeft', 'ArrowUp'] } as const satisfies Record<Orientation, readonly string[]>;

/**
 * The index a key moves to from `index` among `count` items, wrapping at the ends, skipping items `skip` refuses;
 * Home and End go to the first and last. `undefined` when the key doesn't move.
 */
export function moveIndex(key: string, index: number, count: number, orientation: Orientation, skip: (at: number) => boolean = () => false): number | undefined {
  if (count === 0) { return undefined; }
  const forward: readonly string[] = FORWARD[orientation];
  const backward: readonly string[] = BACKWARD[orientation];
  const step = forward.includes(key) ? 1 : backward.includes(key) ? -1 : key === 'Home' ? 'first' : key === 'End' ? 'last' : undefined;
  if (step === undefined) { return undefined; }
  const start = step === 'first' ? -1 : step === 'last' ? count : index;
  const by = step === 'first' ? 1 : step === 'last' ? -1 : step;
  for (let tries = 1; tries <= count; tries++) {
    const at = (((start + by * tries) % count) + count) % count;
    if (!skip(at)) { return at; }
  }
  return undefined;
}

/**
 * Handle a keydown on an item of a roving group (an element marked `data-roving`): focus and choose the item the
 * key moves to. The items are the group's elements matching `selector`, in document order.
 */
export function roveFocus(event: KeyboardEvent, index: number, selector: string, orientation: Orientation, choose: (at: number) => void, skip?: (at: number) => boolean): void {
  const group = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('[data-roving]') : null;
  const items = group === null ? [] : Array.from(group.querySelectorAll<HTMLElement>(selector));
  const next = moveIndex(event.key, index, items.length, orientation, skip);
  if (next === undefined) { return; }
  event.preventDefault();
  items[next]?.focus();
  choose(next);
}
