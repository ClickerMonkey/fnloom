<script setup lang="ts">
/**
 * The Data page (build 8): the stored types the person sees (`/data`), grouped by system, each with how it keeps its
 * records and how many there are, searched by words in the URL (`q`) and opening its records, read from the hub's
 * query a page at a time. The saved widgets are the widgets system's own page (`/s/widgets/saved`; `/data/widgets`
 * redirects there).
 */
import { SystemName } from '@harness/core';
import { computed, watch } from 'vue';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import { bySystem, recordCount, storageWords } from '../data/logic/data.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiIcon, UiInput, relativeTime } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { data } = useStores();
const now = useNow();
const setsQuery = useRouteQuery(ROUTES.data);
const words = setsQuery.draft('q');
const system = setsQuery.text('system');

watch([() => words.value.value, () => system.value], ([text, from]) => {
  const parsed = SystemName.safeParse(from);
  void data.sets.load({ text, system: parsed.success ? parsed.data : undefined });
}, { immediate: true });

const groups = computed(() => bySystem(data.sets.items.value));
</script>

<template>
  <AppPage title="Data" description="Records systems keep in the hub, by type. Open one to search, sort and edit its records.">
    <div class="bar">
      <UiInput v-model="words.draft.value" type="search" icon="search" placeholder="Search stored data" label="Search stored data" hide-label clearable data-testid="data-search" />
    </div>
    <LoadState
      :loading="data.sets.loading.value" :problem="data.sets.problem.value" :ready="data.sets.loaded.value" :empty="data.sets.items.value.length === 0"
      empty-title="No stored data yet" empty-body="Systems that keep records in the hub show them here." empty-icon="database" @retry="data.sets.load()"
    >
      <section v-for="group in groups" :key="group.system" class="group" :data-system="group.system">
        <h2 class="heading">{{ group.system }} <span class="count">{{ group.sets.length }}</span></h2>
        <ul class="list">
          <li v-for="set in group.sets" :key="set.type">
            <RouterLink class="row" :to="links.dataType(set.type)" data-testid="data-set" :data-type="set.type">
              <UiIcon :name="set.storage.shape === 'table' ? 'table' : 'braces'" :size="16" class="lead" />
              <span class="main">
                <span class="name">{{ set.type.slice(set.system.length + 1) }}</span>
                <span v-if="set.description !== ''" class="about">{{ set.description }}</span>
                <span class="how">{{ storageWords(set.storage) }}</span>
              </span>
              <span class="side">
                <span class="records">{{ recordCount(set) }}</span>
                <span v-if="set.updatedAt !== undefined">{{ relativeTime(set.updatedAt, now) }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
      <UiButton v-if="data.sets.hasMore.value" variant="ghost" :loading="data.sets.loadingMore.value" @click="data.sets.more()">More</UiButton>
    </LoadState>
  </AppPage>
</template>

<style scoped>
.bar { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); max-width: 520px; }
.bar > * { flex: 1; }
.group { display: grid; gap: var(--space-2); margin-bottom: var(--space-5); min-width: 0; }
.heading { display: flex; align-items: baseline; gap: var(--space-2); margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.count { color: var(--text-faint); font-weight: var(--weight-medium); }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); width: 100%;
  padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none;
}
.row:hover { background: var(--surface-2); text-decoration: none; }
.row:focus-visible { outline: none; box-shadow: inset var(--ring); }
.lead { color: var(--text-faint); }
.main { display: grid; gap: 2px; min-width: 0; }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.link { justify-self: start; color: var(--text); text-decoration: none; }
.link:hover { color: var(--accent); }
.about { color: var(--text-dim); font-size: var(--text-sm); }
.how { color: var(--text-faint); font-size: var(--text-xs); }
.side { display: grid; justify-items: end; gap: 2px; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap; }
.records { color: var(--text-dim); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
@media (max-width: 520px) {
  .row { grid-template-columns: auto minmax(0, 1fr); }
  .side { grid-column: 2; justify-items: start; display: flex; gap: var(--space-2); }
}
</style>
