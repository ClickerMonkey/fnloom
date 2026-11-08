/**
 * The shell's layout on this device: whether the wide-screen sidebar is collapsed to icons (saved), and whether the
 * narrow-screen navigation drawer is open (not saved: it is a moment, not a place).
 */
import { ref, type Ref } from 'vue';
import { z } from 'zod';
import { persisted, type KeyValueStore } from './persisted.ts';

export const LAYOUT_KEY = 'harness.layout';
const SavedLayout = z.object({ collapsed: z.boolean() });

/** The width below which the sidebar becomes a drawer, in px. The shell's styles key off the class it sets. */
export const COMPACT_BELOW = 760;
/**
 * The height below which the shell is compact too, in px: a phone on its side is wide enough for the sidebar but too
 * short to give it a third of the width and still show the thread over the composer (and the keyboard).
 */
export const SHORT_BELOW = 500;
/** The compact shell (drawer navigation, sheets for panels): a narrow screen, or a short one. */
export const COMPACT_QUERY = `not all and (min-width: ${COMPACT_BELOW}px) and (min-height: ${SHORT_BELOW}px)`;

/** The shell's layout state. */
export class LayoutStore {
  readonly #saved: Ref<z.infer<typeof SavedLayout>>;
  /** Whether the navigation drawer is open (narrow screens). */
  readonly drawerOpen = ref(false);

  constructor(store: KeyValueStore) {
    this.#saved = persisted(store, LAYOUT_KEY, SavedLayout, { collapsed: false });
  }

  /** Whether the sidebar is collapsed to icons (wide screens). */
  get collapsed(): boolean {
    return this.#saved.value.collapsed;
  }

  set collapsed(collapsed: boolean) {
    this.#saved.value = { ...this.#saved.value, collapsed };
  }

  toggleSidebar(): void {
    this.collapsed = !this.collapsed;
  }
}
