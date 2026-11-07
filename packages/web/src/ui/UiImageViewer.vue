<script setup lang="ts">
/**
 * An image, large, over the page (`v-model:open`): fitted to the screen, then zoomed with the buttons, the wheel or a
 * double click, and dragged to pan while zoomed. Escape or the backdrop closes it (through `UiModal`).
 */
import { computed, ref, watch } from 'vue';
import UiIconButton from './UiIconButton.vue';
import UiModal from './UiModal.vue';

const props = defineProps<{ src: string; alt: string }>();
const open = defineModel<boolean>('open', { required: true });

const ZOOMS = [1, 1.5, 2, 3, 4] as const;
const level = ref(0);
const offset = ref({ x: 0, y: 0 });
let drag: { x: number; y: number; from: { x: number; y: number } } | undefined;
const scale = computed(() => ZOOMS[level.value] ?? 1);

function zoom(by: number): void {
  level.value = Math.max(0, Math.min(ZOOMS.length - 1, level.value + by));
  if (level.value === 0) { offset.value = { x: 0, y: 0 }; }
}
function onWheel(event: WheelEvent): void {
  zoom(event.deltaY < 0 ? 1 : -1);
}
function onDown(event: PointerEvent): void {
  if (level.value === 0) { return; }
  drag = { x: event.clientX, y: event.clientY, from: offset.value };
  if (event.currentTarget instanceof Element) { event.currentTarget.setPointerCapture(event.pointerId); }
}
function onMove(event: PointerEvent): void {
  if (drag === undefined) { return; }
  offset.value = { x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y };
}
function onUp(): void {
  drag = undefined;
}
watch(open, (now) => { if (now) { level.value = 0; offset.value = { x: 0, y: 0 }; } });
watch(() => props.src, () => { level.value = 0; offset.value = { x: 0, y: 0 }; });
</script>

<template>
  <UiModal v-model:open="open" :label="alt === '' ? 'Image' : alt" width="min(96vw, 1400px)">
    <div class="viewer" data-testid="image-viewer">
      <div class="tools">
        <UiIconButton icon="minus" label="Zoom out" size="sm" :disabled="level === 0" @click="zoom(-1)" />
        <span class="level" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
        <UiIconButton icon="plus" label="Zoom in" size="sm" :disabled="level === ZOOMS.length - 1" @click="zoom(1)" />
        <UiIconButton icon="x" label="Close" size="sm" @click="open = false" />
      </div>
      <div
        class="stage" :class="{ zoomed: level > 0 }" @wheel.prevent="onWheel" @dblclick="zoom(level === 0 ? 1 : -level)"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
      >
        <img :src="src" :alt="alt" draggable="false" :style="{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }" />
      </div>
      <p v-if="alt !== ''" class="alt">{{ alt }}</p>
    </div>
  </UiModal>
</template>

<style scoped>
.viewer { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: var(--space-2); height: min(88dvh, 1000px); padding: var(--space-2); }
.tools { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); }
.level { min-width: 5ch; color: var(--text-dim); font-size: var(--text-xs); font-variant-numeric: tabular-nums; text-align: center; }
.stage { display: grid; place-items: center; min-height: 0; overflow: hidden; border-radius: var(--radius); background: var(--surface-2); cursor: zoom-in; touch-action: none; }
.stage.zoomed { cursor: grab; }
.stage img { max-width: 100%; max-height: 100%; object-fit: contain; transition: transform var(--fast) var(--ease); user-select: none; }
.alt { margin: 0; color: var(--text-dim); font-size: var(--text-sm); text-align: center; }
</style>
