<script setup lang="ts">
/**
 * A resource in the side panel, shown with the viewer for its format: a system's own viewer when one is registered,
 * otherwise markdown rendered, code and text highlighted in a code block, and anything else described with its size.
 */
import type { ResourceRead } from '@harness/core';
import { computed } from 'vue';
import { UiBanner, UiButton, UiCodeBlock, UiMarkdown, UiSkeleton } from '../../ui/index.ts';
import { formatBytes } from '../logic/format.ts';
import RendererHost from './RendererHost.vue';
import type { RenderView } from './types.ts';

const props = withDefaults(defineProps<{
  read: ResourceRead | undefined;
  loading: boolean;
  problem?: string;
  custom?: RenderView | undefined;
  navigate?: ((href: string) => void) | undefined;
}>(), { problem: '', custom: undefined, navigate: undefined });
const emit = defineEmits<{ retry: [] }>();

const text = computed(() => (props.read?.text !== undefined && 'inline' in props.read.text ? props.read.text.inline : undefined));
const format = computed(() => props.read?.stat.format ?? '');
const isMarkdown = computed(() => format.value === 'markdown' || props.read?.stat.mime === 'text/markdown');
</script>

<template>
  <div class="resource" data-testid="resource-view">
    <UiBanner v-if="problem !== ''" tone="danger">
      {{ problem }}
      <template #actions><UiButton size="sm" variant="ghost" @click="emit('retry')">Retry</UiButton></template>
    </UiBanner>
    <UiSkeleton v-if="loading && read === undefined" shape="lines" :lines="8" />
    <template v-else-if="read">
      <p class="meta">
        <span>{{ read.stat.type }}</span>
        <span v-if="read.stat.format">· {{ read.stat.format }}</span>
        <span v-if="read.stat.size !== undefined">· {{ formatBytes(read.stat.size) }}</span>
      </p>
      <RendererHost v-if="custom" :component="custom.component" :props="custom.props" :label="read.stat.name" />
      <div v-else-if="text !== undefined && isMarkdown" class="markdown"><UiMarkdown :source="text" :navigate="navigate" /></div>
      <UiCodeBlock v-else-if="text !== undefined" :code="text" :language="format" :filename="read.stat.name" line-numbers :max-height="0" />
      <p v-else-if="read.text" class="dim">This is too large to show here.</p>
      <p v-else class="dim">There is no text to show for this {{ read.stat.type }}.</p>
      <ul v-if="read.links && read.links.length > 0" class="links">
        <li v-for="(link, i) in read.links.slice(0, 50)" :key="i"><code>{{ link.title ?? link.raw }}</code> <span class="dim">{{ link.kind }}</span></li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.resource { display: grid; gap: var(--space-3); min-width: 0; }
.meta { display: flex; gap: var(--space-1); margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
.markdown { min-width: 0; overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.links { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: var(--text-xs); }
</style>
