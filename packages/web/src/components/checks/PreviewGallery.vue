<script setup lang="ts">
/**
 * A system's component previews as a gallery: each component with its named states (empty, loading, error, typical,
 * long), and for each state the sizes and themes it was shot in. `limit` shows that many components and says how many
 * more there are (the install card); the review page shows them all.
 */
import type { PreviewShot } from '@harness/core';
import { computed } from 'vue';
import { UiBadge } from '../../ui/index.ts';
import { previewGroups } from './gallery.ts';

const props = withDefaults(defineProps<{ shots: readonly PreviewShot[]; limit?: number | undefined }>(), { limit: undefined });
const groups = computed(() => previewGroups(props.shots));
const shown = computed(() => (props.limit === undefined ? groups.value : groups.value.slice(0, props.limit)));
</script>

<template>
  <div class="gallery-wrap">
    <ul class="gallery" data-testid="checks-previews">
      <li v-for="group in shown" :key="group.component" class="component">
        <span class="name">{{ group.component }}</span>
        <ul class="states">
          <li v-for="state in group.states" :key="state.state" class="state">
            <span class="state-name">{{ state.state }}</span>
            <span class="shots">
              <UiBadge v-for="shot in state.shots" :key="`${shot.viewport}:${shot.theme}`" :title="`${shot.viewport}, ${shot.theme}: ${shot.image.hash.slice(0, 12)}`">{{ shot.viewport }} · {{ shot.theme }}</UiBadge>
            </span>
          </li>
        </ul>
      </li>
    </ul>
    <p v-if="shown.length < groups.length" class="dim">And {{ groups.length - shown.length }} more components.</p>
  </div>
</template>

<style scoped>
.gallery-wrap { display: grid; gap: var(--space-2); }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: var(--space-2); align-items: start; margin: 0; padding: 0; list-style: none; }
.component { display: grid; gap: var(--space-1); padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); min-width: 0; }
.name { font-family: var(--mono); font-size: var(--text-sm); font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.states { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.state { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
.state-name { min-width: 64px; color: var(--text-dim); }
.shots { display: flex; flex-wrap: wrap; gap: 4px; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
