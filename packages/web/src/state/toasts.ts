/**
 * Toasts: short notes that something happened ("Copied", "Couldn't sign out"). They leave on their own after a while,
 * wait while the pointer is over them, and may carry one action. At most a few show at once; the oldest go first.
 */
import { shallowRef } from 'vue';
import type { ToastView, Tone } from '../ui/types.ts';

/** What a caller says to show. */
export interface ToastInput {
  readonly title: string;
  readonly body?: string;
  readonly tone?: Tone;
  /** A button on the toast, and what it does. Choosing it also dismisses the toast. */
  readonly action?: { readonly label: string; readonly run: () => void };
  /** How long it stays, in ms; 0 keeps it until dismissed. */
  readonly duration?: number;
}

/** How long toasts stay by default, and how many show at once. */
export interface ToastSettings {
  readonly duration: number;
  readonly max: number;
}

export const TOAST_DEFAULTS: ToastSettings = { duration: 5_000, max: 4 };

interface Entry {
  readonly view: ToastView;
  readonly run: (() => void) | undefined;
  readonly duration: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The queue of toasts on screen. */
export class Toasts {
  readonly #settings: ToastSettings;
  readonly #entries = new Map<number, Entry>();
  readonly #views = shallowRef<readonly ToastView[]>([]);
  #next = 1;

  constructor(settings: ToastSettings = TOAST_DEFAULTS) {
    this.#settings = settings;
  }

  /** The toasts showing, oldest first. */
  get items(): readonly ToastView[] {
    return this.#views.value;
  }

  /** Show a toast; returns its id. */
  push(input: ToastInput): number {
    const id = this.#next++;
    const view: ToastView = {
      id, tone: input.tone ?? 'neutral', title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.action === undefined ? {} : { action: input.action.label }),
    };
    const entry: Entry = { view, run: input.action?.run, duration: input.duration ?? this.#settings.duration, timer: undefined };
    this.#entries.set(id, entry);
    this.#arm(entry);
    while (this.#entries.size > this.#settings.max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) { break; }
      this.dismiss(oldest.value);
    }
    this.#publish();
    return id;
  }

  /** Shorthands for the common tones. */
  ok(title: string, body?: string): number { return this.push({ tone: 'ok', title, ...(body === undefined ? {} : { body }) }); }
  error(title: string, body?: string): number { return this.push({ tone: 'danger', title, ...(body === undefined ? {} : { body }) }); }

  /** Remove a toast. */
  dismiss(id: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) { return; }
    clearTimeout(entry.timer);
    this.#entries.delete(id);
    this.#publish();
  }

  /** Run a toast's action, then remove it. */
  act(id: number): void {
    const entry = this.#entries.get(id);
    this.dismiss(id);
    entry?.run?.();
  }

  /** Hold a toast while it is being read (pointer over it, or focus in it). */
  hold(id: number): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) { return; }
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  /** Let a held toast leave again, after its full duration. */
  release(id: number): void {
    const entry = this.#entries.get(id);
    if (entry !== undefined && entry.timer === undefined) { this.#arm(entry); }
  }

  #arm(entry: Entry): void {
    if (entry.duration > 0) { entry.timer = setTimeout(() => { this.dismiss(entry.view.id); }, entry.duration); }
  }

  #publish(): void {
    this.#views.value = Array.from(this.#entries.values(), (entry) => entry.view);
  }
}
