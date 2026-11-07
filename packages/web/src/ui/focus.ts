/** Keyboard focus helpers for overlays: what can take focus inside an element, and keeping Tab inside it. */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

/** The elements inside `root` that Tab reaches, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

/** Focus the element marked `[data-autofocus]`, else the first focusable, else `root` itself. */
export function focusFirst(root: HTMLElement): void {
  const marked = root.querySelector<HTMLElement>('[data-autofocus]');
  const target = marked ?? focusables(root)[0] ?? root;
  target.focus({ preventScroll: true });
}

/** Keep Tab and Shift+Tab cycling inside `root`. Call from a keydown handler; returns whether it moved focus. */
export function trapTab(event: KeyboardEvent, root: HTMLElement): boolean {
  if (event.key !== 'Tab') { return false; }
  const items = focusables(root);
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const active = root.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
