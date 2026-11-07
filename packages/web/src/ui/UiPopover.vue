<script setup lang="ts">
/**
 * A floating panel next to an anchor element (`v-model:open`). It takes its content's natural size, capped to the
 * viewport, flips and slides to stay on screen, follows the anchor on scroll and resize, and closes on Escape or a
 * press outside. Focus moves in when it opens and back to the anchor when it closes.
 */
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue';
import { place, type Align, type Side } from './floating.ts';
import { useOverlay } from './overlay.ts';

const props = withDefaults(defineProps<{
  anchor: HTMLElement | null | undefined;
  side?: Side;
  align?: Align;
  offset?: number;
  /** The panel's role: `dialog` for free content, `menu` and `listbox` for their components. */
  role?: 'dialog' | 'menu' | 'listbox';
  label?: string | undefined;
  /** Be at least as wide as the anchor. */
  matchWidth?: boolean;
  takeFocus?: boolean;
}>(), { side: 'bottom', align: 'start', offset: 6, role: 'dialog', label: undefined, matchWidth: false, takeFocus: true });

const open = defineModel<boolean>('open', { required: true });
const panel = ref<HTMLElement | null>(null);
const placed = ref({ left: 0, top: 0, maxWidth: 0, maxHeight: 0, side: props.side });
const MARGIN = 8;

const style = computed(() => ({
  left: `${placed.value.left}px`,
  top: `${placed.value.top}px`,
  maxWidth: `${placed.value.maxWidth}px`,
  maxHeight: `${placed.value.maxHeight}px`,
  minWidth: props.matchWidth && props.anchor ? `${Math.min(props.anchor.offsetWidth, placed.value.maxWidth)}px` : undefined,
}));

function reposition(): void {
  const el = panel.value;
  const anchor = props.anchor;
  if (!el || !anchor) { return; }
  el.style.maxWidth = 'none';
  el.style.maxHeight = 'none';
  const natural = { width: el.offsetWidth, height: el.offsetHeight };
  placed.value = place(anchor.getBoundingClientRect(), natural, { width: window.innerWidth, height: window.innerHeight }, { side: props.side, align: props.align, offset: props.offset, margin: MARGIN });
  el.style.maxWidth = `${placed.value.maxWidth}px`;
  el.style.maxHeight = `${placed.value.maxHeight}px`;
}

let observer: ResizeObserver | undefined;
function follow(): void {
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);
  if (typeof ResizeObserver !== 'undefined' && panel.value) {
    observer = new ResizeObserver(() => { reposition(); });
    observer.observe(panel.value);
  }
}
function unfollow(): void {
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', reposition, true);
  observer?.disconnect();
  observer = undefined;
}

watch(open, async (now) => {
  if (now) {
    await nextTick();
    reposition();
    follow();
  } else {
    unfollow();
  }
}, { immediate: true });
onBeforeUnmount(unfollow);

useOverlay(open, panel, { onClose: () => { open.value = false; }, modal: false, dismissOnOutside: true, takeFocus: props.takeFocus, anchor: toRef(props, 'anchor') });

defineSlots<{ default: () => unknown }>();
defineExpose({ reposition });
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-popover">
      <div
        v-if="open" ref="panel" class="ui-popover" data-layer :class="`from-${placed.side}`" :role="role" :aria-label="label" tabindex="-1"
        :style="style"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-popover {
  position: fixed; z-index: var(--z-popover); width: max-content; overflow: auto; overscroll-behavior: contain;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg);
}
.ui-popover:focus-visible { outline: none; }
.ui-popover-enter-active { transition: opacity var(--medium) var(--ease), transform var(--medium) var(--ease); }
.ui-popover-leave-active { transition: opacity var(--fast) var(--ease), transform var(--fast) var(--ease); }
.ui-popover-enter-from, .ui-popover-leave-to { opacity: 0; }
.ui-popover-enter-from.from-bottom, .ui-popover-leave-to.from-bottom { transform: translateY(-4px) scale(0.98); }
.ui-popover-enter-from.from-top, .ui-popover-leave-to.from-top { transform: translateY(4px) scale(0.98); }
.ui-popover-enter-from.from-left, .ui-popover-leave-to.from-left { transform: translateX(4px) scale(0.98); }
.ui-popover-enter-from.from-right, .ui-popover-leave-to.from-right { transform: translateX(-4px) scale(0.98); }
</style>
