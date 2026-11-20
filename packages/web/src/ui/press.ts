/**
 * A long press on a control, for touch and mouse alike: holding the primary pointer down for `delay` ms, or the
 * context-menu gesture (right-click, or a touch long-press where the browser reports one), calls `onLong` with the
 * control. The click a held press ends in is not a plain press, so `consumed(event)` swallows it once; a keyboard
 * click (`detail` 0) is never swallowed, so Enter and Space always do the control's plain action.
 */
import { onBeforeUnmount } from 'vue';

/** How long a press is held before it counts as long. */
export const LONG_PRESS_MS = 500;

/** The listeners to bind on the control (`v-on`), and the check its click handler makes first. */
export interface LongPress {
  readonly handlers: {
    readonly pointerdown: (event: PointerEvent) => void;
    readonly pointerup: () => void;
    readonly pointerleave: () => void;
    readonly pointercancel: () => void;
    readonly contextmenu: (event: MouseEvent) => void;
  };
  /** True when this click ends a long press (it was already handled); then it should do nothing. */
  consumed(event: MouseEvent): boolean;
}

export function useLongPress(onLong: (target: HTMLElement) => void, delay: number = LONG_PRESS_MS): LongPress {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const cancel = (): void => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  };
  onBeforeUnmount(cancel);
  return {
    handlers: {
      pointerdown(event) {
        fired = false;
        cancel();
        const target = event.currentTarget;
        if (event.button !== 0 || !(target instanceof HTMLElement)) return;
        timer = setTimeout(() => { timer = undefined; fired = true; onLong(target); }, delay);
      },
      pointerup: cancel,
      pointerleave: cancel,
      pointercancel: cancel,
      contextmenu(event) {
        event.preventDefault();
        const target = event.currentTarget;
        const pending = timer !== undefined;
        cancel();
        // a touch long-press can report both: the timer already opened it
        if (fired || !(target instanceof HTMLElement)) return;
        // held from a pointer press, its click may still come; a right-click has none
        if (pending) { fired = true; }
        onLong(target);
      },
    },
    consumed(event) {
      const was = fired && event.detail !== 0;
      fired = false;
      return was;
    },
  };
}
