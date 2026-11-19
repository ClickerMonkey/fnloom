<script setup lang="ts">
/**
 * A draggable divider between two side-by-side panes: drag it (mouse, pen or touch) or focus it and use the arrow
 * keys (Home and End jump to the limits) to set the width of the pane on its `side`: the one `before` it (a tree
 * on the left, the default) or the one `after` it (a side panel on the right, which grows as the divider moves left).
 * `v-model` is that width in px, kept between `min` and `max`; double-click puts it back to `reset`.
 */
import { onBeforeUnmount, shallowRef } from 'vue';
import { clampWidth, dragWidth, type SplitSide } from './split.ts';

const props = withDefaults(defineProps<{ label: string; min: number; max: number; reset: number; step?: number; side?: SplitSide }>(), { step: 16, side: 'before' });
const width = defineModel<number>({ required: true });
const dragging = shallowRef(false);
let stop: (() => void) | undefined;

function set(next: number): void {
  width.value = clampWidth(next, props.min, props.max);
}

function start(event: PointerEvent): void {
  if (event.button !== 0) { return; }
  event.preventDefault();
  const from = event.clientX;
  const was = width.value;
  dragging.value = true;
  const move = (e: PointerEvent): void => { set(dragWidth(was, e.clientX - from, props.side)); };
  const end = (): void => { stop?.(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    dragging.value = false;
    stop = undefined;
  };
}

function key(event: KeyboardEvent): void {
  const moves: Readonly<Record<string, number>> = {
    ArrowLeft: dragWidth(width.value, -props.step, props.side), ArrowRight: dragWidth(width.value, props.step, props.side), Home: props.min, End: props.max,
  };
  const next = moves[event.key];
  if (next === undefined) { return; }
  event.preventDefault();
  set(next);
}

onBeforeUnmount(() => { stop?.(); });
</script>

<template>
  <div
    class="ui-splitter" :class="{ dragging }" role="separator" aria-orientation="vertical" tabindex="0" :aria-label="label"
    :aria-valuenow="width" :aria-valuemin="min" :aria-valuemax="max" data-testid="splitter"
    @pointerdown="start" @keydown="key" @dblclick="set(reset)"
  />
</template>

<style scoped>
/* a thin line with a wide, invisible grab area */
.ui-splitter { position: relative; width: 1px; min-height: 0; background: var(--border); cursor: col-resize; touch-action: none; }
.ui-splitter::before { content: ''; position: absolute; inset: 0 -5px; }
.ui-splitter::after { content: ''; position: absolute; inset: 0 -1px; background: var(--accent); opacity: 0; transition: opacity var(--fast) var(--ease); }
.ui-splitter:hover::after, .ui-splitter.dragging::after { opacity: 0.6; }
.ui-splitter:focus-visible { outline: none; }
.ui-splitter:focus-visible::after { opacity: 1; }
</style>
