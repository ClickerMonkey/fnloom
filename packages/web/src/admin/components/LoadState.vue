<script setup lang="ts">
/**
 * What a section shows before and around its content: a skeleton while the first load runs, the problem with Retry
 * when it fails, an empty state when there is nothing, and the content otherwise. A problem after content has
 * loaded shows above it, so what was there stays.
 */
import { UiBanner, UiButton, UiEmpty, UiSkeleton, type IconName } from '../../ui/index.ts';

withDefaults(defineProps<{
  loading: boolean;
  problem: string;
  /** Whether there is content to show. */
  ready: boolean;
  empty: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyIcon?: IconName;
  lines?: number;
}>(), { emptyTitle: 'Nothing here yet', emptyBody: '', emptyIcon: 'sparkles', lines: 4 });
const emit = defineEmits<{ retry: [] }>();
const slots = defineSlots<{ default: () => unknown; empty?: () => unknown }>();
</script>

<template>
  <div class="load-state">
    <UiBanner v-if="problem !== ''" tone="danger">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" icon="refresh" data-testid="retry" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <UiSkeleton v-if="!ready && loading" shape="lines" :lines="lines" />
    <template v-else-if="ready && empty">
      <slot v-if="slots.empty" name="empty" />
      <UiEmpty v-else :icon="emptyIcon" :title="emptyTitle" :body="emptyBody" />
    </template>
    <slot v-else-if="ready" />
  </div>
</template>

<style scoped>
.load-state { display: grid; gap: var(--space-4); min-width: 0; }
</style>
