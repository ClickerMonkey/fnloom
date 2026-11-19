<script setup lang="ts">
/**
 * The saved widgets (`/s/widgets/saved`, was the Data page's Widgets tab at `/data/widgets`): every `widgets/widget`
 * fn the person sees, searched by the hub's fn search in its database by the words in the URL (`?q=`), a page at a
 * time. Each shows its fn (a pill that opens the fn), what it shows and what blocks it, and opens in a new chat, where
 * it runs as the person's run and its chips, pager and row actions work. It draws with the app's own frame, search,
 * load state, buttons and fn pills, so it looks like the rest of the app.
 */
import { fnLabel, type FnSearchHit } from '@harness/core';
import type { PageViewOf } from '@harness/sdk';
import { computed, ref, watch } from 'vue';
import type { WidgetsContract } from '../shared/index.ts';
import { widgetSearch } from './proposal.ts';

const view = defineProps<PageViewOf<WidgetsContract>>();
const { Frame, Input, LoadState, Button, FnPill, Icon } = view.host.components;
const search = view.host.query.bind('q');
const fns = view.host.hub.caller('searchFns', { lastOnly: true });

const items = ref<readonly FnSearchHit[]>([]);
const next = ref<number | undefined>(undefined);
const loading = ref(true);
const loadingMore = ref(false);
const loaded = ref(false);
const problem = ref('');
const opening = ref('');
const empty = computed(() => loaded.value && items.value.length === 0);
const searching = computed(() => search.value.trim() !== '');

async function load(more = false): Promise<void> {
  if (more && next.value === undefined) { return; }
  if (more) { loadingMore.value = true; } else { loading.value = true; }
  try {
    const page = await fns.call(widgetSearch(search.value, more ? (next.value ?? 0) : 0));
    items.value = more ? [...items.value, ...page.items] : page.items;
    next.value = page.next;
    problem.value = '';
    loaded.value = true;
  } catch (error) {
    problem.value = error instanceof Error ? error.message : "Couldn't load the saved widgets.";
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}
watch(() => search.value, () => { void load(); }, { immediate: true });

async function open(hit: FnSearchHit): Promise<void> {
  opening.value = hit.name;
  try {
    await view.host.openChat({ title: fnLabel(hit.name), run: { fn: hit.name, args: {} } });
  } catch (error) {
    problem.value = error instanceof Error ? error.message : "Couldn't open the widget.";
  } finally {
    opening.value = '';
  }
}
</script>

<template>
  <Frame title="Widgets" description="Saved views of data. Open one in a chat to run it with its controls and actions.">
    <div class="bar">
      <Input v-model="search.value" type="search" icon="search" label="Search widgets" placeholder="Search widgets" hide-label clearable data-testid="widgets-search" />
    </div>
    <LoadState
      :loading="loading && !loaded" :problem="problem" :ready="loaded" :empty="empty" empty-icon="grid"
      :empty-title="searching ? 'No widgets match' : 'No widgets yet'"
      :empty-body="searching ? 'Try other words, or clear the search.' : 'Ask in a chat to keep a result as a widget, or use Make a widget in any table’s menu.'"
      @retry="load()"
    >
      <ul class="list" :class="{ dim: loading }" data-testid="widgets-list">
        <li v-for="widget in items" :key="widget.name" class="widget" data-testid="widget-row" :data-widget="widget.name">
          <Icon name="grid" :size="16" class="lead" />
          <span class="main">
            <span class="name"><FnPill :name="widget.name" :off="!widget.available" /></span>
            <span v-if="widget.description !== ''" class="about">{{ widget.description }}</span>
            <span v-if="widget.blocked !== undefined" class="how">{{ widget.blocked.reason }}</span>
          </span>
          <Button size="sm" icon="play" :loading="opening === widget.name" :disabled="!widget.available || opening !== ''" data-testid="widget-open" @click="open(widget)">
            Open in chat
          </Button>
        </li>
      </ul>
      <Button v-if="next !== undefined" variant="ghost" :loading="loadingMore" data-testid="widgets-more" @click="load(true)">More</Button>
    </LoadState>
  </Frame>
</template>

<style scoped>
.bar { display: flex; margin-bottom: var(--space-4); max-width: 520px; }
.bar > * { flex: 1; }
.list {
  display: grid; margin: 0 0 var(--space-3); padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface);
  list-style: none; overflow: hidden; transition: opacity var(--medium, 200ms) var(--ease);
}
.list.dim { opacity: 0.6; }
.list > li + li { border-top: 1px solid var(--border); }
.widget {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-4); animation: ui-rise-in var(--medium, 200ms) var(--ease);
}
.widget:hover { background: var(--surface-2); }
.lead { color: var(--text-faint); }
.main { display: grid; gap: 2px; min-width: 0; }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.about { color: var(--text-dim); font-size: var(--text-sm); }
.how { color: var(--text-faint); font-size: var(--text-xs); }
@media (max-width: 520px) {
  .widget { grid-template-columns: auto minmax(0, 1fr); }
  .widget > :last-child { grid-column: 2; justify-self: start; }
}
</style>
