<script setup lang="ts">
/**
 * The page card for `web/read`: the page's title and site, where it ended up, whether the browser rendered it and
 * whether the text was cut, and a compact preview of the hub resource it was kept as (the chat's `ResourceViewer`,
 * which draws its markdown form). Before the hub's viewer is there (or without one) it shows the start of the text.
 */
import { RESOURCE_VIEWER, type FnViewOf } from '@harness/sdk';
import StatusChip from './StatusChip.vue';
import { computed, inject } from 'vue';
import type { web } from '../shared/index.ts';
import { pageFacts, statusChip } from './view.ts';

const view = defineProps<FnViewOf<typeof web, 'read'>>();

/** Characters of text shown when there is no resource viewer. */
const EXCERPT = 600;

const viewer = inject(RESOURCE_VIEWER, undefined);
const chip = computed(() => statusChip(view.status, view.error));
const running = computed(() => view.status === 'running' || view.status === 'queued');
const facts = computed(() => pageFacts(view.args.url, view.result));
const excerpt = computed(() => {
  const text = view.result?.text.trim() ?? '';
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT).trimEnd()}…` : text;
});
const chars = computed(() => new Intl.NumberFormat(navigator.language).format(facts.value.chars));
</script>

<template>
  <article class="page" :data-tone="chip.tone" :aria-busy="running">
    <header class="head">
      <span class="badge" aria-hidden="true">{{ facts.domain.charAt(0).toUpperCase() }}</span>
      <div class="names">
        <h3 class="title" :title="facts.title">{{ facts.title }}</h3>
        <a class="url" :href="view.result?.finalUrl ?? view.args.url" target="_blank" rel="noopener noreferrer" :title="facts.shown">{{ facts.shown }}</a>
      </div>
      <StatusChip :chip="chip" />
    </header>

    <ul v-if="view.result" class="facts" aria-label="About this page">
      <li v-if="facts.rendered" class="fact rendered" title="It was built by scripts, so it was run in a headless browser first">Rendered</li>
      <li v-if="facts.moved" class="fact">Redirected</li>
      <li class="fact">{{ chars }} characters{{ facts.truncated ? ', cut short' : '' }}</li>
    </ul>

    <div v-if="running" class="progress" role="progressbar" aria-label="Reading the page"><div class="bar" /></div>

    <div v-if="view.result" class="preview">
      <component :is="viewer" v-if="viewer" :uri="view.result.uri" compact />
      <p v-else-if="excerpt" class="excerpt">{{ excerpt }}</p>
    </div>

    <p v-if="view.error" class="problem" role="alert">{{ view.error.message }}</p>
  </article>
</template>

<style scoped>
.page {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  transition: border-color var(--slow) var(--ease);
}
.page[data-tone='busy'] { border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
.page[data-tone='bad'] { border-color: color-mix(in oklab, var(--danger) 35%, var(--border)); }
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--text-sm);
  font-weight: var(--weight-strong);
}
.names { display: grid; flex: 1 1 auto; min-width: 0; }
.title { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.url { color: var(--text-dim); font: var(--text-xs)/1.4 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
.url:hover { color: var(--accent); text-decoration: underline; }
.facts { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.fact { padding: 1px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--text-dim); font-size: var(--text-xs); }
.fact.rendered { color: var(--accent); border-color: color-mix(in oklab, var(--accent) 35%, var(--border)); }
.progress { height: 3px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
.bar {
  width: 40%;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  animation: slide 1.2s var(--ease) infinite;
}
.preview { min-width: 0; max-height: 320px; overflow: auto; border-radius: var(--radius-sm); }
.excerpt { margin: 0; color: var(--text); font-size: var(--text-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) {
  .bar { animation: none; }
}
</style>
