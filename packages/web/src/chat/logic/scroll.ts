/**
 * How the thread's scroll box behaves, apart from the DOM so it is tested alone. It follows new content while the
 * reader is at the bottom: tokens streaming, run cards arriving or opening, markdown and images laying out after the
 * first paint. Only the reader moving up stops following; content growing below them never does, even when the
 * growth is first seen by a scroll event. Scrolled up, the row at the top of the view stays where it is when
 * anything above it changes (older history prepended, a card opening), and rows arriving below are counted.
 */

/** What the follower reads from and writes to the scroll box. Offsets are from the top of the visible box, in px. */
export interface ScrollLayout {
  /** How far the box is scrolled (scrollTop). */
  readonly top: number;
  /** The height of everything in it (scrollHeight). */
  readonly height: number;
  /** The height of the visible box (clientHeight). */
  readonly view: number;
  /** Scroll to `top`, at once or smoothly. */
  scrollTo(top: number, smooth: boolean): void;
  /** The first row at least partly in view, and where its top is. */
  firstVisible(): { readonly key: string; readonly offset: number } | undefined;
  /** Where a row's top is now, if it is drawn. */
  offsetOf(key: string): number | undefined;
}

/** How close to the bottom counts as at the bottom, and how close to the top asks for older history (px). */
export interface ScrollSettings {
  readonly slack: number;
  readonly reach: number;
}

export const SCROLL_SETTINGS: ScrollSettings = { slack: 80, reach: 320 };

/** What a scroll event led to. */
export interface ScrollOutcome {
  /** Whether the view is (or is following to) the bottom. */
  readonly atBottom: boolean;
  /** Whether older history should be asked for. */
  readonly older: boolean;
}

/** The thread's scroll behaviour over one scroll box. */
export class ScrollFollower {
  readonly #layout: ScrollLayout;
  readonly #settings: ScrollSettings;
  #stick = true;
  #lastTop = 0;
  #anchor: { readonly key: string; readonly offset: number } | undefined;
  #fresh = 0;
  /** A smooth scroll to the bottom is under way. */
  #gliding = false;

  constructor(layout: ScrollLayout, settings: ScrollSettings = SCROLL_SETTINGS) {
    this.#layout = layout;
    this.#settings = settings;
  }

  /** Whether the view follows new content. */
  get following(): boolean {
    return this.#stick;
  }

  /** Rows that arrived below while the reader was scrolled up. */
  get fresh(): number {
    return this.#fresh;
  }

  /** How far the view is from the bottom, in px. */
  distance(): number {
    const { height, top, view } = this.#layout;
    return Math.max(0, height - top - view);
  }

  /**
   * The box scrolled. At the bottom it follows again. Moving up is the reader leaving the bottom. Anything else while
   * following (the box scrolled down, or content grew below before this event saw it) is followed to the bottom.
   */
  scrolled(): ScrollOutcome {
    const top = this.#layout.top;
    const bottom = this.distance() <= this.#settings.slack;
    if (bottom) {
      this.#stick = true;
      this.#fresh = 0;
      this.#gliding = false;
    } else if (this.#gliding) {
      // a smooth scroll to the bottom passes through here
    } else if (top < this.#lastTop - 1) {
      this.#stick = false;
    } else if (this.#stick) {
      this.#jump(false);
    }
    this.#lastTop = this.#layout.top;
    this.#capture();
    return { atBottom: this.#stick, older: top < this.#settings.reach };
  }

  /** The reader moved up by hand (wheel, touch, keys): stop following even before the scroll event lands. */
  leave(): void {
    if (this.distance() > 0) {
      this.#stick = false;
      this.#gliding = false;
    }
  }

  /** The rows are about to change: remember what the reader is looking at. */
  beforeChange(): void {
    this.#capture();
  }

  /** Rows were added below the last known one. Counted while scrolled up. */
  added(count: number): void {
    if (!this.#stick && count > 0) { this.#fresh += count; }
  }

  /** The content or the box changed size: stay at the bottom when following, else keep the reader's row in place. */
  resized(): void {
    if (this.#stick) {
      this.#jump(this.#gliding);
      return;
    }
    const kept = this.#anchor;
    const now = kept === undefined ? undefined : this.#layout.offsetOf(kept.key);
    if (kept === undefined || now === undefined) { return; }
    const moved = now - kept.offset;
    if (Math.abs(moved) >= 1) {
      this.#layout.scrollTo(this.#layout.top + moved, false);
      this.#lastTop = this.#layout.top;
    }
  }

  /** Go to the bottom and follow again. */
  toBottom(smooth = false): void {
    this.#stick = true;
    this.#fresh = 0;
    this.#gliding = smooth && this.distance() > 0;
    this.#jump(this.#gliding);
  }

  /** Stop following and keep the current view (a deep link brought a message into view). */
  hold(): void {
    this.#stick = false;
    this.#gliding = false;
    this.#lastTop = this.#layout.top;
    this.#capture();
  }

  #jump(smooth: boolean): void {
    const target = Math.max(0, this.#layout.height - this.#layout.view);
    this.#layout.scrollTo(target, smooth);
    this.#lastTop = smooth ? this.#lastTop : this.#layout.top;
  }

  #capture(): void {
    this.#anchor = this.#layout.firstVisible();
  }
}
