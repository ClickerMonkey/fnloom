/**
 * The shell's layout on this device: whether the wide-screen sidebar is collapsed to icons, how wide the resource
 * tree is and whether the chat groups fn calls in a row into one collapsed section (saved), and whether the narrow-screen navigation drawer is open (not saved: it is a moment, not a place).
 */
import { ref, type Ref } from 'vue';
import { z } from 'zod';
import { persisted, type KeyValueStore } from './persisted.ts';

export const LAYOUT_KEY = 'harness.layout';
/** The resource tree's width: its default and the range its divider allows, in px. */
export const TREE_WIDTH = { reset: 260, min: 180, max: 520 } as const;
const SavedLayout = z.object({
  collapsed: z.boolean(),
  treeWidth: z.number().int().min(TREE_WIDTH.min).max(TREE_WIDTH.max).default(TREE_WIDTH.reset),
  groupRuns: z.boolean().default(true),
});

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
  /**
   * The name of the one thing the page is about (`fs`, `Review fs`), set by a page that keeps its title: the phone's
   * top bar shows it instead of the route's generic name ("System"). Not saved.
   */
  readonly pageTitle = ref<string | undefined>(undefined);

  constructor(store: KeyValueStore) {
    this.#saved = persisted(store, LAYOUT_KEY, SavedLayout, { collapsed: false, treeWidth: TREE_WIDTH.reset, groupRuns: true });
  }

  /** Whether the sidebar is collapsed to icons (wide screens). */
  get collapsed(): boolean {
    return this.#saved.value.collapsed;
  }

  set collapsed(collapsed: boolean) {
    this.#saved.value = { ...this.#saved.value, collapsed };
  }

  /** The resource tree's width in px (wide screens). */
  get treeWidth(): number {
    return this.#saved.value.treeWidth;
  }

  set treeWidth(treeWidth: number) {
    this.#saved.value = { ...this.#saved.value, treeWidth };
  }

  /** Whether the chat collapses fn calls in a row into one section (on by default). */
  get groupRuns(): boolean {
    return this.#saved.value.groupRuns;
  }

  set groupRuns(groupRuns: boolean) {
    this.#saved.value = { ...this.#saved.value, groupRuns };
  }

  toggleSidebar(): void {
    this.collapsed = !this.collapsed;
  }
}
