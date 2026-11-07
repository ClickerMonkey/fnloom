/**
 * The theme: light or dark following the device, unless this device has chosen one. The shown theme is set as
 * `data-theme` on <html>, which pins the tokens' `color-scheme`.
 */
import { computed, ref, watch, type Ref } from 'vue';
import { z } from 'zod';
import { persisted, type KeyValueStore } from './persisted.ts';

export const THEME_KEY = 'harness.theme';
/** What a person can choose. */
export const ThemeChoice = z.enum(['system', 'light', 'dark']);
export type ThemeChoice = z.infer<typeof ThemeChoice>;
/** What the page shows. */
export type Theme = Exclude<ThemeChoice, 'system'>;

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The part of a `MediaQueryList` the theme uses. */
export interface DeviceQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (event: { readonly matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { readonly matches: boolean }) => void): void;
}

/** The parts of the page the theme touches, so tests can pass their own. */
export interface ThemeHost {
  readonly store: KeyValueStore;
  readonly media: (query: string) => DeviceQuery;
  readonly root: HTMLElement;
}

/** The chosen and shown theme. */
export class ThemeStore {
  /** What this device chose. */
  readonly choice: Ref<ThemeChoice>;
  readonly #deviceDark = ref(false);
  readonly #dispose: () => void;

  constructor(host: ThemeHost) {
    this.choice = persisted(host.store, THEME_KEY, ThemeChoice, 'system');
    const media = host.media(DARK_QUERY);
    this.#deviceDark.value = media.matches;
    const follow = (event: { readonly matches: boolean }): void => { this.#deviceDark.value = event.matches; };
    media.addEventListener('change', follow);
    const stop = watch(this.theme, (theme) => { host.root.dataset['theme'] = theme; }, { immediate: true, flush: 'sync' });
    this.#dispose = () => { media.removeEventListener('change', follow); stop(); };
  }

  /** The theme the page shows now. */
  readonly theme = computed<Theme>(() => (this.choice.value === 'system' ? (this.#deviceDark.value ? 'dark' : 'light') : this.choice.value));

  /** Stop following the device and updating the page. */
  dispose(): void {
    this.#dispose();
  }
}
