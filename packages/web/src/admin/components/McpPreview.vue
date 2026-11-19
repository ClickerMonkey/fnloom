<script setup lang="ts">
/**
 * What an MCP's rules expose now: its fns, types (and those pulled in only because an exposed fn needs them), context,
 * resource roots, the fns its fns may call under the same grant, and warnings (an excluded type a fn needs, context
 * that brings a fn that isn't exposed). Live while the rules are edited. Fns (exposed, and those they may call) are
 * `FnPill`s that open the fn modal.
 */
import type { McpScopePreview } from '@harness/core';
import { computed } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import { UiBadge, UiBanner, UiSkeleton, UiSpinner } from '../../ui/index.ts';

const props = withDefaults(defineProps<{ preview: McpScopePreview | undefined; loading: boolean; problem?: string }>(), { problem: '' });

const groups = computed(() => {
  const p = props.preview;
  if (p === undefined) { return []; }
  return [
    { key: 'fns', title: 'Fns', items: p.fns, about: 'Tools an MCP client can call.', fns: true },
    { key: 'types', title: 'Types', items: p.types, about: '' },
    { key: 'closure', title: 'Types the fns need', items: p.closure, about: 'Exposed because an exposed fn takes or returns them.' },
    { key: 'context', title: 'Context', items: p.context, about: '' },
    { key: 'resources', title: 'Resources', items: p.resources.map((r) => (r.system === undefined ? r.uri : `${r.uri} on ${r.system}${r.instance === undefined ? '' : `@${r.instance}`}`)), about: '' },
    { key: 'reach', title: 'Fns they may call', items: p.reach, about: 'Run under the same grant when an exposed fn calls them.', fns: true },
  ];
});
</script>

<template>
  <section class="preview" data-testid="mcp-preview" aria-live="polite">
    <header class="head">
      <h3 class="title">What it exposes</h3>
      <UiSpinner v-if="loading && preview" :size="14" />
    </header>
    <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    <UiSkeleton v-if="preview === undefined && loading" shape="lines" :lines="6" />
    <template v-else-if="preview">
      <UiBanner v-for="(warning, i) in preview.warnings" :key="i" tone="warn" data-testid="mcp-warning">{{ warning }}</UiBanner>
      <div v-for="group in groups" :key="group.key" class="group" :data-group="group.key">
        <p class="group-title">{{ group.title }} <span class="count">{{ group.items.length }}</span></p>
        <p v-if="group.about !== '' && group.items.length > 0" class="about">{{ group.about }}</p>
        <p v-if="group.items.length > 0 && group.fns" class="items"><FnPill v-for="item in group.items" :key="item" :name="item" /></p>
        <p v-else-if="group.items.length > 0" class="items"><UiBadge v-for="item in group.items" :key="item"><code>{{ item }}</code></UiBadge></p>
        <p v-else class="about">None.</p>
      </div>
      <p class="note">Fns tagged admin are never exposed, whatever the rules say.</p>
    </template>
  </section>
</template>

<style scoped>
.preview { display: grid; gap: var(--space-3); align-content: start; min-width: 0; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.head { display: flex; align-items: center; gap: var(--space-2); }
.title { margin: 0; font-size: var(--text-md); font-weight: var(--weight-strong); }
.group { display: grid; gap: var(--space-1); }
.group-title { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.count { color: var(--text-faint); font-weight: var(--weight-normal, 400); }
.about, .note { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
.items { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; }
.items code { font-size: var(--text-xs); }
</style>
