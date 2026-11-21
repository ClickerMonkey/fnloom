<script setup lang="ts">
/**
 * The web search card: the query and its filters, a live status chip, Tavily's short answer, and the results (title,
 * site, date, snippet), each opening the page in a new tab or starting a `web/read` of it ("Read", whose own card
 * follows in the chat). Placeholder rows shimmer while the search runs; long snippets clamp until expanded.
 */
import type { FnViewOf } from '@harness/sdk';
import StatusChip from './StatusChip.vue';
import { computed, ref } from 'vue';
import type { web } from '../shared/index.ts';
import { resultRows, statusChip, useStarts } from './view.ts';

const view = defineProps<FnViewOf<typeof web, 'search'>>();

/** Results drawn before "Show all". */
const FIRST = 5;

const chip = computed(() => statusChip(view.status, view.error));
const running = computed(() => view.status === 'running' || view.status === 'queued');
const rows = computed(() => resultRows(view.result?.results ?? [], navigator.language));
const all = ref(false);
const shown = computed(() => (all.value ? rows.value : rows.value.slice(0, FIRST)));
const opened = ref(new Set<string>());
const filters = computed(() => [
  ...(view.args.topic === 'news' ? ['News'] : []),
  ...(view.args.depth === 'advanced' ? ['Deep'] : []),
  ...(view.args.days === undefined ? [] : [`Last ${view.args.days} ${view.args.days === 1 ? 'day' : 'days'}`]),
  ...(view.args.include ?? []).map((domain) => `Only ${domain}`),
  ...(view.args.exclude ?? []).map((domain) => `Not ${domain}`),
]);
const starts = useStarts();

function toggle(key: string): void {
  const next = new Set(opened.value);
  if (next.has(key)) { next.delete(key); } else { next.add(key); }
  opened.value = next;
}
/** Why the Read of a result couldn't start, if it couldn't. */
function problemOf(url: string): string | undefined {
  const state = starts.states[url];
  return state?.phase === 'failed' ? state.message : undefined;
}
function read(url: string): void {
  starts.start(url, () => view.system.run.read({ url }));
}
</script>

<template>
  <article class="search" :data-tone="chip.tone" :aria-busy="running">
    <header class="head">
      <svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></svg>
      <h3 class="query" :title="view.args.query">{{ view.args.query }}</h3>
      <StatusChip :chip="chip" />
    </header>
    <ul v-if="filters.length > 0" class="filters" aria-label="Filters">
      <li v-for="filter in filters" :key="filter" class="filter">{{ filter }}</li>
    </ul>

    <div v-if="running && !view.result" class="placeholder" aria-hidden="true">
      <div v-for="n in 3" :key="n" class="ghost"><span class="line wide" /><span class="line" /></div>
    </div>

    <p v-if="view.result?.answer" class="answer"><span class="label">Answer</span>{{ view.result.answer }}</p>

    <ol v-if="shown.length > 0" class="results">
      <li v-for="row in shown" :key="row.key" class="result">
        <div class="site">
          <span class="badge" aria-hidden="true">{{ row.domain.charAt(0).toUpperCase() }}</span>
          <span class="domain" :title="row.shown">{{ row.shown }}</span>
          <span v-if="row.published" class="date">{{ row.published }}</span>
        </div>
        <a v-if="row.href" class="title" :href="row.href" target="_blank" rel="noopener noreferrer">{{ row.title }}</a>
        <span v-else class="title">{{ row.title }}</span>
        <p
          v-if="row.snippet" class="snippet" :class="{ open: opened.has(row.key) }"
          role="button" tabindex="0" :aria-expanded="opened.has(row.key)"
          @click="toggle(row.key)" @keydown.enter.prevent="toggle(row.key)" @keydown.space.prevent="toggle(row.key)"
        >
          {{ row.snippet }}
        </p>
        <div class="actions">
          <button
            type="button" class="action"
            :disabled="!view.system.online || starts.states[row.url]?.phase === 'starting'"
            @click="read(row.url)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h4a2 2 0 0 1 2 2v7a1.5 1.5 0 0 0-1.5-1.5h-4.5zM13.5 3.5h-4a2 2 0 0 0-1 .3M13.5 3.5V11H9" /></svg>
            {{ starts.states[row.url]?.phase === 'starting' ? 'Starting…' : 'Read' }}
          </button>
          <a v-if="row.href" class="action" :href="row.href" target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>
            Open
          </a>
          <span v-if="starts.states[row.url]?.phase === 'started'" class="note started" role="status">Reading below</span>
          <span v-else-if="problemOf(row.url)" class="note problem" role="alert">{{ problemOf(row.url) }}</span>
        </div>
      </li>
    </ol>
    <p v-else-if="view.result" class="empty">No results. Try other words, or fewer filters.</p>

    <button v-if="rows.length > FIRST" type="button" class="more" @click="all = !all">
      {{ all ? 'Show fewer' : `Show all ${rows.length} results` }}
    </button>
    <p v-if="!view.system.online && view.result" class="note">web is offline; Read works once it reconnects</p>
    <p v-if="view.error" class="problem" role="alert">{{ view.error.message }}</p>
  </article>
</template>

<style scoped>
.search {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  transition: border-color var(--slow) var(--ease);
}
.search[data-tone='busy'] { border-color: color-mix(in oklab, var(--accent) 45%, var(--border)); }
.search[data-tone='bad'] { border-color: color-mix(in oklab, var(--danger) 35%, var(--border)); }
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.icon { flex: none; width: 16px; height: 16px; fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-linecap: round; }
.query { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); line-height: 1.4; overflow-wrap: anywhere; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
.filter { padding: 1px var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--text-dim); font-size: var(--text-xs); }
.answer {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.label { color: var(--accent); font-size: var(--text-xs); font-weight: var(--weight-strong); text-transform: uppercase; letter-spacing: 0.04em; }
.results { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.result { display: grid; gap: var(--space-1); min-width: 0; animation: rise var(--slow) var(--ease) both; }
.site { display: flex; align-items: center; gap: var(--space-2); min-width: 0; color: var(--text-dim); font-size: var(--text-xs); }
.badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 10px;
  font-weight: var(--weight-strong);
}
.domain { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.date { flex: none; }
.date::before { content: '·'; margin-right: var(--space-2); }
.title { color: var(--accent); font-size: var(--text-md, var(--text-sm)); font-weight: var(--weight-strong); line-height: 1.35; text-decoration: none; overflow-wrap: anywhere; }
.title:hover { text-decoration: underline; }
.title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.snippet {
  margin: 0;
  color: var(--text);
  font-size: var(--text-sm);
  line-height: 1.5;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
}
.snippet.open { display: block; }
.snippet:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: var(--text-sm);
  text-decoration: none;
  cursor: pointer;
  transition: background var(--fast) var(--ease), transform var(--fast) var(--ease);
}
.action:hover:not(:disabled) { background: var(--surface-2); }
.action:active:not(:disabled) { transform: scale(0.97); }
.action:disabled { opacity: 0.5; cursor: default; }
.action svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.placeholder { display: grid; gap: var(--space-3); }
.ghost { display: grid; gap: var(--space-1); }
.line { display: block; height: 10px; width: 60%; border-radius: 5px; background: linear-gradient(90deg, var(--surface-2), var(--border), var(--surface-2)); background-size: 200% 100%; animation: flow 1.4s linear infinite; }
.line.wide { width: 85%; }
.more {
  justify-self: start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: var(--text-sm);
  cursor: pointer;
}
.empty, .note { margin: 0; color: var(--text-dim); font-size: var(--text-xs); }
.note.started { color: var(--ok); animation: rise var(--slow) var(--ease); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
@keyframes flow { to { background-position: -200% 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) {
  .line, .result, .note.started { animation: none; }
}
</style>
