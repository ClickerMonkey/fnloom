/**
 * The stack of open overlays (popovers, menus, sheets, dialogs). Escape closes only the top one, and a press outside
 * the top one closes only it when it asks for that, so a menu inside a dialog closes before the dialog does.
 */

/** An open overlay. */
export interface Layer {
  /** Close it. */
  close(): void;
  /** The elements that count as inside it (its panel, and its anchor). A press on none of them is outside. */
  contains(target: Node): boolean;
  /** Close on a press outside it. */
  readonly dismissOnOutside: boolean;
}

/** The open overlays, newest last. */
export class LayerStack {
  readonly #layers: Layer[] = [];

  /** Add an overlay on top; returns the function that removes it. */
  push(layer: Layer): () => void {
    this.#layers.push(layer);
    return () => {
      const at = this.#layers.indexOf(layer);
      if (at >= 0) { this.#layers.splice(at, 1); }
    };
  }

  /** The overlay on top, if any. */
  get top(): Layer | undefined {
    return this.#layers.at(-1);
  }

  /** How many overlays are open. */
  get size(): number {
    return this.#layers.length;
  }

  /** Handle Escape: close the top overlay. Returns whether one was closed. */
  escape(): boolean {
    const top = this.top;
    if (top === undefined) { return false; }
    top.close();
    return true;
  }

  /** Handle a press: close the top overlay when the press is outside it and it asks for that. */
  press(target: Node): boolean {
    const top = this.top;
    if (top === undefined || !top.dismissOnOutside || top.contains(target)) { return false; }
    top.close();
    return true;
  }

  /** Listen on a document for Escape and presses. Returns the function that stops listening. */
  listen(doc: Document): () => void {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && this.escape()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onPress = (event: PointerEvent): void => {
      if (event.target instanceof Node) { this.press(event.target); }
    };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('pointerdown', onPress, true);
    return () => {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('pointerdown', onPress, true);
    };
  }
}

/** The app's one stack, listening on the page's document from the first import in a browser. */
export const layers = new LayerStack();
if (typeof document !== 'undefined') { layers.listen(document); }
