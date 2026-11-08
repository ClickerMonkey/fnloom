<script setup lang="ts">
/**
 * An image (or an SVG, which never runs scripts inside an `<img>`): fitted to the panel on a checkered backdrop (so
 * transparency shows), zoomed in place with the buttons or a double click, and opened large in the image viewer
 * (zoom, pan) with the expand button. Its natural size shows once it has loaded.
 */
import { computed, ref } from 'vue';
import { UiIconButton } from '../../ui/index.ts';
import UiImageViewer from '../../ui/UiImageViewer.vue';

const props = withDefaults(defineProps<{ src: string; alt: string; compact?: boolean }>(), { compact: false });

const ZOOMS = [1, 1.5, 2, 3] as const;
const level = ref(0);
const large = ref(false);
const natural = ref<{ width: number; height: number } | undefined>(undefined);
const scale = computed(() => ZOOMS[level.value] ?? 1);
const zoom = (by: number): void => { level.value = Math.max(0, Math.min(ZOOMS.length - 1, level.value + by)); };

function loaded(event: Event): void {
  if (event.target instanceof HTMLImageElement) { natural.value = { width: event.target.naturalWidth, height: event.target.naturalHeight }; }
}
</script>

<template>
  <figure class="image-viewer" :class="{ compact }" data-testid="image-view">
    <div class="stage" :class="{ zoomed: level > 0 }" @dblclick="level = level === 0 ? 1 : 0">
      <img :src="props.src" :alt="alt" loading="lazy" :style="level > 0 ? { width: `${scale * 100}%`, maxWidth: 'none' } : undefined" @load="loaded" />
    </div>
    <figcaption v-if="!compact" class="bar">
      <span class="size">{{ natural ? `${natural.width} × ${natural.height}` : '' }}</span>
      <UiIconButton icon="minus" size="sm" label="Zoom out" :disabled="level === 0" @click="zoom(-1)" />
      <span class="level" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
      <UiIconButton icon="plus" size="sm" label="Zoom in" :disabled="level === ZOOMS.length - 1" @click="zoom(1)" />
      <UiIconButton icon="zoom-in" size="sm" label="Open large" data-testid="image-open" @click="large = true" />
    </figcaption>
    <UiImageViewer v-if="!compact" v-model:open="large" :src="src" :alt="alt" />
  </figure>
</template>

<style scoped>
.image-viewer { display: grid; gap: var(--space-2); margin: 0; min-width: 0; }
.stage {
  display: grid; place-items: center; min-height: 160px; max-height: min(70dvh, 720px); overflow: auto; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius);
  background-color: var(--surface-2);
  background-image: linear-gradient(45deg, var(--surface-3) 25%, transparent 25%, transparent 75%, var(--surface-3) 75%), linear-gradient(45deg, var(--surface-3) 25%, transparent 25%, transparent 75%, var(--surface-3) 75%);
  background-position: 0 0, 8px 8px; background-size: 16px 16px; cursor: zoom-in;
}
.stage.zoomed { place-items: start; cursor: zoom-out; }
.compact .stage { min-height: 0; max-height: 180px; padding: var(--space-1); }
.stage img { display: block; max-width: 100%; max-height: 100%; height: auto; object-fit: contain; }
.bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-1); }
.size { flex: 1; color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.level { min-width: 5ch; color: var(--text-dim); font-size: var(--text-xs); text-align: center; font-variant-numeric: tabular-nums; }
</style>
