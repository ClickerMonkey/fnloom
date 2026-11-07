<script setup lang="ts" generic="T extends { readonly key: string }">
/**
 * The thread's scroll box. It follows new content only while the reader is at the bottom (within `slack` px);
 * scrolling up stops following at once, even mid-stream. When content above the reader changes (older history
 * prepended, a card expanding, an image loading), what the reader is looking at stays put. Scrolled up, a "Jump to
 * latest" button counts what arrived below ("3 new", or "Needs you" when something waits on the person). Near the
 * top it asks for older history, with a spinner, and marks the beginning of the chat.
 *
 * It is a log for screen readers: finished answers are announced by the thread, not each token.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { UiIcon, UiSpinner } from '../../ui/index.ts';

const props = withDefaults(defineProps<{
  items: readonly T[];
  hasOlder: boolean;
  loadingOlder: boolean;
  beginning: boolean;
  /** Something waits on the person (an approval, a form). */
  needsYou?: boolean;
  /** How close to the bottom counts as at the bottom, in px. */
  slack?: number;
  /** How close to the top asks for older history, in px. */
  reach?: number;
}>(), { needsYou: false, slack: 80, reach: 320 });

const emit = defineEmits<{ older: []; bottom: [atBottom: boolean] }>();
defineSlots<{ item: (props: { item: T; index: number }) => unknown; foot?: () => unknown; empty?: () => unknown }>();

const box = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const atBottom = ref(true);
/** Rows that arrived below while scrolled up. */
const fresh = ref(0);
let stick = true;
let anchor: { key: string; top: number } | undefined;
let observer: ResizeObserver | undefined;

function distance(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/** Remember the first row the reader can see, and where it is. */
function capture(): void {
  const el = box.value;
  const list = content.value;
  if (el === null || list === null) { return; }
  const top = el.getBoundingClientRect().top;
  for (const row of list.querySelectorAll<HTMLElement>('[data-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top) {
      const key = row.dataset['key'];
      anchor = key === undefined ? undefined : { key, top: rect.top - top };
      return;
    }
  }
}

/** Put the remembered row back where it was. */
function restore(): void {
  const el = box.value;
  const list = content.value;
  const kept = anchor;
  if (el === null || list === null || kept === undefined) { return; }
  const row = list.querySelector<HTMLElement>(`[data-key="${CSS.escape(kept.key)}"]`);
  if (row === null) { return; }
  const now = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  const moved = now - kept.top;
  if (Math.abs(moved) >= 1) { el.scrollTop += moved; }
}

/** Keep up with a change in the content's size. */
function follow(): void {
  const el = box.value;
  if (el === null) { return; }
  if (stick) { el.scrollTop = el.scrollHeight; } else { restore(); }
}

function onScroll(): void {
  const el = box.value;
  if (el === null) { return; }
  const bottom = distance(el) <= props.slack;
  if (bottom !== atBottom.value) { emit('bottom', bottom); }
  atBottom.value = bottom;
  stick = bottom;
  if (bottom) { fresh.value = 0; }
  capture();
  if (el.scrollTop < props.reach && props.hasOlder && !props.loadingOlder) { emit('older'); }
}

/** Go to the bottom and follow again. */
function toBottom(smooth = false): void {
  const el = box.value;
  stick = true;
  fresh.value = 0;
  atBottom.value = true;
  if (el === null) { return; }
  if (smooth && typeof el.scrollTo === 'function') { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); } else { el.scrollTop = el.scrollHeight; }
}

/** Bring an element of the thread into view (a deep link, a quoted message). Returns whether it was found. */
function reveal(id: string): boolean {
  const target = content.value?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (target === null || target === undefined) { return false; }
  stick = false;
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
  capture();
  return true;
}

watch(() => props.items.map((item) => item.key), (keys, before) => {
  capture();
  const known = new Set(before);
  const lastKnown = before.at(-1);
  const tailStart = lastKnown === undefined ? 0 : keys.indexOf(lastKnown) + 1;
  const added = keys.slice(tailStart).filter((key) => !known.has(key)).length;
  if (!stick && added > 0 && before.length > 0) { fresh.value += added; }
  void nextTick(follow);
}, { flush: 'pre' });

onMounted(() => {
  void nextTick(() => { toBottom(); });
  // the content growing (streaming, a card opening) and the box shrinking (the composer growing) both move the bottom
  if (typeof ResizeObserver !== 'undefined' && content.value !== null && box.value !== null) {
    observer = new ResizeObserver(() => { follow(); });
    observer.observe(content.value);
    observer.observe(box.value);
  }
});
onBeforeUnmount(() => { observer?.disconnect(); });

defineExpose({ toBottom, reveal, atBottom });
</script>

<template>
  <div class="scroller-wrap">
    <div ref="box" class="scroller" role="log" aria-live="off" aria-label="Messages" tabindex="0" data-testid="thread" @scroll.passive="onScroll">
      <div ref="content" class="content">
        <div v-if="loadingOlder" class="edge" data-testid="loading-older"><UiSpinner :size="16" label="Loading older messages" /></div>
        <div v-else-if="beginning && items.length > 0" class="edge beginning" data-testid="beginning">Beginning of chat</div>
        <slot v-if="items.length === 0" name="empty" />
        <div v-for="(item, index) in items" :key="item.key" class="row" :data-key="item.key">
          <slot name="item" :item="item" :index="index" />
        </div>
        <slot name="foot" />
      </div>
    </div>
    <Transition name="jump">
      <button v-if="!atBottom" type="button" class="jump" :class="{ needs: needsYou }" data-testid="jump-latest" @click="toBottom(true)">
        <UiIcon :name="needsYou ? 'shield' : 'chevron-down'" :size="16" />
        <span>{{ fresh > 0 ? `${fresh} new` : needsYou ? 'Needs you' : 'Jump to latest' }}</span>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.scroller-wrap { position: relative; display: grid; grid-template-rows: minmax(0, 1fr); min-height: 0; }
.scroller { min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; overflow-anchor: none; scrollbar-gutter: stable; }
.scroller:focus-visible { outline: none; box-shadow: inset var(--ring); }
.content { display: grid; gap: var(--space-3); width: 100%; max-width: calc(var(--readable) + 120px); margin: 0 auto; padding: var(--space-5) var(--space-5) var(--space-4); }
.row { min-width: 0; }
.edge { display: flex; justify-content: center; padding: var(--space-2) 0; color: var(--text-faint); font-size: var(--text-xs); }
.beginning { letter-spacing: 0.02em; }
.jump {
  position: absolute; left: 50%; bottom: var(--space-3); display: inline-flex; align-items: center; gap: var(--space-1); height: 36px; padding: 0 var(--space-4);
  transform: translateX(-50%); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); color: var(--text);
  box-shadow: var(--shadow); font-size: var(--text-sm); font-weight: var(--weight-medium); z-index: var(--z-sticky);
}
.jump.needs { border-color: var(--warn); color: var(--warn); }
.jump:focus-visible { outline: none; box-shadow: var(--shadow), var(--ring); }
.jump-enter-active, .jump-leave-active { transition: opacity var(--medium) var(--ease), transform var(--medium) var(--ease); }
.jump-enter-from, .jump-leave-to { opacity: 0; transform: translate(-50%, 8px); }
@media (max-width: 759.98px) { .content { padding: var(--space-4) var(--space-3) var(--space-3); } }
</style>
