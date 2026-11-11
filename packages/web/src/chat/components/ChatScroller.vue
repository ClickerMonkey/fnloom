<script setup lang="ts" generic="T extends { readonly key: string }">
/**
 * The thread's scroll box. It follows new content only while the reader is at the bottom (within `slack` px);
 * scrolling up stops following at once, even mid-stream. When content above the reader changes (older history
 * prepended, a card expanding, an image loading), what the reader is looking at stays put. Scrolled up, a "Jump to
 * latest" button counts what arrived below ("3 new"); what waits on the person (approvals, questions) sits in the dock
 * under the thread, always in sight, so the button never points at it. Near the top it asks for older history, with a spinner, and marks the beginning of the chat.
 *
 * It is a log for screen readers: finished answers are announced by the thread, not each token.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { UiIcon, UiSpinner } from '../../ui/index.ts';
import { ScrollFollower, type ScrollLayout } from '../logic/scroll.ts';

const props = withDefaults(defineProps<{
  items: readonly T[];
  hasOlder: boolean;
  loadingOlder: boolean;
  beginning: boolean;
  /** How close to the bottom counts as at the bottom, in px. */
  slack?: number;
  /** How close to the top asks for older history, in px. */
  reach?: number;
}>(), { slack: 80, reach: 320 });

const emit = defineEmits<{ older: []; bottom: [atBottom: boolean] }>();
defineSlots<{ item: (props: { item: T; index: number }) => unknown; foot?: () => unknown; empty?: () => unknown }>();

const box = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const atBottom = ref(true);
/** Rows that arrived below while scrolled up. */
const fresh = ref(0);
let observer: ResizeObserver | undefined;

/** The scroll box as the follower sees it. */
const layout: ScrollLayout = {
  get top() { return box.value?.scrollTop ?? 0; },
  get height() { return box.value?.scrollHeight ?? 0; },
  get view() { return box.value?.clientHeight ?? 0; },
  scrollTo(top, smooth) {
    const el = box.value;
    if (el === null) { return; }
    if (smooth && typeof el.scrollTo === 'function') { el.scrollTo({ top, behavior: 'smooth' }); } else { el.scrollTop = top; }
  },
  firstVisible() {
    const el = box.value;
    if (el === null || content.value === null) { return undefined; }
    const top = el.getBoundingClientRect().top;
    for (const row of content.value.querySelectorAll<HTMLElement>('[data-key]')) {
      const rect = row.getBoundingClientRect();
      const key = row.dataset['key'];
      if (rect.bottom > top && key !== undefined) { return { key, offset: rect.top - top }; }
    }
    return undefined;
  },
  offsetOf(key) {
    const el = box.value;
    const row = content.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    return el === null || row === null || row === undefined ? undefined : row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  },
};
const follower = new ScrollFollower(layout, { slack: props.slack, reach: props.reach });

/** Show what the follower knows. */
function sync(bottom: boolean): void {
  if (bottom !== atBottom.value) { emit('bottom', bottom); }
  atBottom.value = bottom;
  fresh.value = follower.fresh;
}

function onScroll(): void {
  const outcome = follower.scrolled();
  sync(outcome.atBottom);
  if (outcome.older && props.hasOlder && !props.loadingOlder) { emit('older'); }
}

/** A wheel, swipe or key moving up is the reader leaving the bottom, whatever the content does meanwhile. */
function onWheel(event: WheelEvent): void {
  if (event.deltaY < 0) { follower.leave(); sync(follower.following); }
}
let touchY: number | undefined;
function onTouchStart(event: TouchEvent): void {
  touchY = event.touches[0]?.clientY;
}
function onTouchMove(event: TouchEvent): void {
  const y = event.touches[0]?.clientY;
  if (touchY !== undefined && y !== undefined && y > touchY + 4) { follower.leave(); sync(follower.following); }
  touchY = y;
}
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
function onKey(event: KeyboardEvent): void {
  if (UP_KEYS.has(event.key)) { follower.leave(); sync(follower.following); }
}

/** Go to the bottom and follow again. */
function toBottom(smooth = false): void {
  follower.toBottom(smooth);
  sync(true);
}

/** Bring an element of the thread into view (a deep link, a quoted message). Returns whether it was found. */
function reveal(id: string): boolean {
  const target = content.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (target === null || target === undefined) { return false; }
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
  follower.hold();
  sync(follower.distance() <= props.slack);
  return true;
}

watch(() => props.items.map((item) => item.key), (keys, before) => {
  follower.beforeChange();
  const known = new Set(before);
  const lastKnown = before.at(-1);
  const tailStart = lastKnown === undefined ? 0 : keys.indexOf(lastKnown) + 1;
  if (before.length > 0) { follower.added(keys.slice(tailStart).filter((key) => !known.has(key)).length); }
  fresh.value = follower.fresh;
  void nextTick(() => { follower.resized(); });
}, { flush: 'pre' });

/** The pill floats over the thread; while it shows, the end of the thread gets room to scroll clear of it. */
const clear = computed(() => !atBottom.value);

onMounted(() => {
  void nextTick(() => { toBottom(); });
  // the content growing (streaming, a card opening, markdown laying out) and the box shrinking (the composer growing) both move the bottom
  if (typeof ResizeObserver !== 'undefined' && content.value !== null && box.value !== null) {
    observer = new ResizeObserver(() => { follower.resized(); });
    observer.observe(content.value);
    observer.observe(box.value);
  }
});
onBeforeUnmount(() => { observer?.disconnect(); });

defineExpose({ toBottom, reveal, atBottom });
</script>

<template>
  <div class="scroller-wrap">
    <div ref="box" class="scroller" role="log" aria-live="off" aria-label="Messages" tabindex="0" data-testid="thread" @scroll.passive="onScroll" @wheel.passive="onWheel" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove" @keydown="onKey">
      <div ref="content" class="content" :class="{ clear }">
        <div v-if="loadingOlder" class="edge" data-testid="loading-older"><UiSpinner :size="16" label="Loading older messages" /></div>
        <div v-else-if="beginning && items.length > 0" class="edge beginning" data-testid="beginning">Beginning of chat</div>
        <slot v-if="items.length === 0" name="empty" />
        <div v-for="(item, index) in items" :key="item.key" class="row" :data-key="item.key">
          <slot name="item" :item="item" :index="index" />
        </div>
        <slot name="foot" />
      </div>
    </div>
    <!-- floats over the thread on purpose, so the layout checks treat it as a layer -->
    <Transition name="jump">
      <button v-if="!atBottom" type="button" class="jump" data-testid="jump-latest" data-layer @click="toBottom(true)">
        <UiIcon name="chevron-down" :size="16" />
        <span>{{ fresh > 0 ? `${fresh} new` : 'Jump to latest' }}</span>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.scroller-wrap { position: relative; display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
.scroller { min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; overflow-anchor: none; scrollbar-gutter: stable both-edges; }
.scroller:focus-visible { outline: none; box-shadow: inset var(--ring); }
.content { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); width: 100%; max-width: calc(var(--readable) + 120px); margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-4); }
.content.clear { padding-bottom: calc(var(--space-4) + 36px + var(--space-3)); }
.row { min-width: 0; }
.edge { display: flex; justify-content: center; padding: var(--space-2) 0; color: var(--text-faint); font-size: var(--text-xs); }
.beginning { letter-spacing: 0.02em; }
.jump {
  position: absolute; left: 50%; bottom: var(--space-3); display: inline-flex; align-items: center; gap: var(--space-1); height: 36px; padding: 0 var(--space-4);
  transform: translateX(-50%); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); color: var(--text);
  box-shadow: var(--shadow); font-size: var(--text-sm); font-weight: var(--weight-medium); z-index: var(--z-sticky);
}
.jump:focus-visible { outline: none; box-shadow: var(--shadow), var(--ring); }
.jump-enter-active, .jump-leave-active { transition: opacity var(--medium) var(--ease), transform var(--medium) var(--ease); }
.jump-enter-from, .jump-leave-to { opacity: 0; transform: translate(-50%, 8px); }
@media (max-width: 759.98px) { .content { padding: var(--space-4) var(--space-3) var(--space-3); } }
</style>
