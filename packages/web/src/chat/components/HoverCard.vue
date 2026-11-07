<script setup lang="ts">
/**
 * A mention's card, fetched live from its system: title, subtitle, a few fields, a short preview and where it leads.
 * A skeleton while it loads; a quiet "Not available" when the system is offline or the thing is gone. A system may
 * draw its own card (`custom`).
 */
import type { MentionHover } from '@harness/core';
import { UiButton, UiMarkdown, UiSkeleton } from '../../ui/index.ts';
import type { RenderView } from './types.ts';

withDefaults(defineProps<{
  label: string;
  hover: MentionHover | undefined;
  loading: boolean;
  problem?: string;
  custom?: RenderView | undefined;
}>(), { problem: '', custom: undefined });

const emit = defineEmits<{ open: [] }>();
</script>

<template>
  <div class="hover-card" data-testid="hover-card">
    <div v-if="loading" class="loading" aria-label="Loading">
      <UiSkeleton shape="lines" :lines="3" />
    </div>
    <component :is="custom.component" v-else-if="custom" v-bind="custom.props" />
    <template v-else-if="hover">
      <header class="head">
        <h3 class="title">{{ hover.title }}</h3>
        <p v-if="hover.subtitle" class="subtitle">{{ hover.subtitle }}</p>
      </header>
      <dl v-if="hover.fields && hover.fields.length > 0" class="fields">
        <template v-for="field in hover.fields" :key="field.label">
          <dt>{{ field.label }}</dt>
          <dd>{{ field.value }}</dd>
        </template>
      </dl>
      <div v-if="hover.body" class="body"><UiMarkdown :source="hover.body" /></div>
      <footer v-if="hover.open" class="foot">
        <UiButton size="sm" variant="ghost" icon-right="arrow-right" @click="emit('open')">Open</UiButton>
      </footer>
    </template>
    <p v-else class="gone">{{ problem || `${label} isn't available right now.` }}</p>
  </div>
</template>

<style scoped>
.hover-card { display: grid; gap: var(--space-3); width: min(340px, calc(100vw - 32px)); padding: var(--space-3) var(--space-4); }
.loading { padding: var(--space-1) 0; }
.head { display: grid; gap: 2px; }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.subtitle { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.fields { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px var(--space-3); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-faint); }
dd { margin: 0; overflow-wrap: anywhere; }
.body { max-height: 160px; overflow: auto; font-size: var(--text-sm); }
.foot { display: flex; justify-content: flex-end; }
.gone { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
