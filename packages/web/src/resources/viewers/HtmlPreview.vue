<script setup lang="ts">
/**
 * An html page drawn in a sandboxed frame from its source (`srcdoc`): no scripts, no forms, no same origin, so the
 * page can't reach the app or the hub. Its height is the reader's choice (short, tall, or the screen).
 */
import { ref } from 'vue';
import { UiSegmented, type SegmentOption } from '../../ui/index.ts';

withDefaults(defineProps<{ html: string; title?: string; compact?: boolean }>(), { title: 'Page', compact: false });

type Height = 's' | 'm' | 'l';
const HEIGHTS: readonly SegmentOption<Height>[] = [{ value: 's', label: 'Short' }, { value: 'm', label: 'Tall' }, { value: 'l', label: 'Screen' }];
const height = ref<Height>('m');
</script>

<template>
  <div class="html-preview" :class="[`h-${compact ? 's' : height}`]" data-testid="html-view">
    <div v-if="!compact" class="tools">
      <span class="note">Drawn without its scripts</span>
      <UiSegmented v-model="height" :options="HEIGHTS" label="Preview height" />
    </div>
    <iframe class="frame" :srcdoc="html" sandbox="" referrerpolicy="no-referrer" :title="title"></iframe>
  </div>
</template>

<style scoped>
.html-preview { display: grid; gap: var(--space-2); min-width: 0; }
.tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); }
.note { color: var(--text-faint); font-size: var(--text-xs); }
.frame { width: 100%; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; }
.h-s .frame { height: 220px; }
.h-m .frame { height: min(60dvh, 640px); }
.h-l .frame { height: calc(100dvh - 160px); }
</style>
