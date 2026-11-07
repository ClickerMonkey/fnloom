/**
 * The behaviour every overlay shares, as composables: joining the layer stack while open (Escape and outside presses),
 * moving focus in and giving it back, keeping Tab inside modal ones, and locking the page's scroll behind them.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { focusFirst, focusables, trapTab } from './focus.ts';
import { layers } from './layers.ts';

/** How an overlay behaves. */
export interface OverlayOptions {
  /** Called when the overlay asks to close (Escape, a press outside). */
  readonly onClose: () => void;
  /** Modal overlays trap Tab and lock the page's scroll. */
  readonly modal: boolean;
  /** Close on a press outside the panel and anchor. */
  readonly dismissOnOutside: boolean;
  /** Move focus into the panel when it opens. */
  readonly takeFocus: boolean;
  /** The element that opened it, which counts as inside and gets focus back (when focus was inside on closing). */
  readonly anchor?: Ref<HTMLElement | null | undefined>;
}

let locks = 0;
/** Lock the page's scroll while any modal overlay is open. Returns the unlock function. */
function lockScroll(doc: Document): () => void {
  if (locks === 0) { doc.documentElement.style.overflow = 'hidden'; }
  locks++;
  return () => {
    locks--;
    if (locks === 0) { doc.documentElement.style.overflow = ''; }
  };
}

/** Run an overlay's shared behaviour while `open` is true. */
export function useOverlay(open: Ref<boolean>, panel: Ref<HTMLElement | null | undefined>, options: OverlayOptions): void {
  let release: (() => void) | undefined;
  let unlock: (() => void) | undefined;
  let returnTo: HTMLElement | null = null;

  const onKey = (event: KeyboardEvent): void => {
    const root = panel.value;
    if (options.modal && root) { trapTab(event, root); }
  };

  async function start(): Promise<void> {
    const doc = document;
    returnTo = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    release = layers.push({
      close: options.onClose,
      dismissOnOutside: options.dismissOnOutside,
      contains: (target) => (panel.value?.contains(target) ?? false) || (options.anchor?.value?.contains(target) ?? false),
    });
    if (options.modal) { unlock = lockScroll(doc); }
    doc.addEventListener('keydown', onKey);
    await nextTick();
    if (options.takeFocus && panel.value) { focusFirst(panel.value); }
  }

  function stop(): void {
    if (release === undefined) { return; }
    release();
    release = undefined;
    unlock?.();
    unlock = undefined;
    document.removeEventListener('keydown', onKey);
    // give focus back only when it was inside the overlay (Escape, a choice), not when a press outside moved it
    const active = document.activeElement;
    const inside = active === null || active === document.body || (panel.value?.contains(active) ?? false);
    const anchor = options.anchor?.value;
    const target = anchor ? (anchor.matches('button, a[href], input, [tabindex]') ? anchor : focusables(anchor)[0] ?? anchor) : returnTo;
    if (inside && target?.isConnected === true) { target.focus({ preventScroll: true }); }
    returnTo = null;
  }

  watch(open, (now) => { if (now) { void start(); } else { stop(); } });
  onMounted(() => { if (open.value) { void start(); } });
  onBeforeUnmount(stop);
}

/** Whether a media query matches, kept up to date. */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const matches = ref(false);
  let list: MediaQueryList | undefined;
  const update = (): void => { matches.value = list?.matches ?? false; };
  onMounted(() => {
    list = window.matchMedia(query);
    update();
    list.addEventListener('change', update);
  });
  onBeforeUnmount(() => { list?.removeEventListener('change', update); });
  return matches;
}
