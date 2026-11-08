<script setup lang="ts">
/**
 * Every context item the person may see (`/context`), all of it in the URL: words (`q`), an origin (`origin`: from a
 * system, memory, or made from a resource) and a system (`system`), page by page. "Remember" (`?remember=1`) writes a
 * memory and "From a resource" (`?from=1`) makes context from one; each opens the item it made. Live: a change to any
 * item refreshes the list quietly.
 */
import type { ContextFromResourceArgs, ContextOriginType } from '@harness/core';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import ContextRow from '../context/components/ContextRow.vue';
import FromResourceDialog from '../context/components/FromResourceDialog.vue';
import MemoryDialog from '../context/components/MemoryDialog.vue';
import { filterOf, isFiltered, ORIGIN_WORDS, OriginChoice, readContextQuery, type MemoryDraft } from '../context/logic/context.ts';
import { useStores } from '../state/stores.ts';
import { UiButton, UiInput, UiSegmented, type SegmentOption } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { context, resources, toasts } = useStores();
const finder = resources.search();
const router = useRouter();
const now = useNow();
const query = useRouteQuery(ROUTES.context);
const search = query.draft('q');
const originText = query.text('origin');
const systemText = query.text('system');
const rememberOpen = query.text('remember', { push: true });
const fromOpen = query.text('from', { push: true });

const ALL = 'all';
type OriginOption = ContextOriginType | typeof ALL;
const ORIGINS: readonly SegmentOption<OriginOption>[] = [
  { value: ALL, label: 'All' },
  ...OriginChoice.options.map((origin) => ({ value: origin, label: ORIGIN_WORDS[origin].short, icon: ORIGIN_WORDS[origin].icon })),
];
const origin = computed({
  get: (): OriginOption => { const parsed = OriginChoice.safeParse(originText.value); return parsed.success ? parsed.data : ALL; },
  set: (next: OriginOption) => { originText.value = next === ALL ? '' : next; },
});
const remembering = computed({ get: () => rememberOpen.value === '1', set: (isOpen) => { rememberOpen.value = isOpen ? '1' : ''; } });
const making = computed({ get: () => fromOpen.value === '1', set: (isOpen) => { fromOpen.value = isOpen ? '1' : ''; } });

const filter = computed(() => filterOf(readContextQuery({ q: search.value.value, origin: originText.value, system: systemText.value })));
watch(() => JSON.stringify(filter.value), () => { void context.show(filter.value); }, { immediate: true });
context.follow();

const items = computed(() => context.list.items.value);
const filtered = computed(() => isFiltered(filter.value));

async function remember(draft: MemoryDraft): Promise<void> {
  const result = await context.remember(draft);
  if (!result.ok) { return; }
  toasts.ok('Remembered', result.value);
  await router.replace(links.contextItem(result.value));
}

async function fromResource(args: ContextFromResourceArgs): Promise<void> {
  const result = await context.fromResource(args);
  if (!result.ok) { return; }
  const made = [...result.value.created, ...result.value.updated];
  const first = made[0];
  toasts.ok(result.value.created.length > 0 ? `Made ${made.length} context ${made.length === 1 ? 'item' : 'items'}` : 'Context updated', `${result.value.links} links`);
  await router.replace(first === undefined ? links.context() : links.contextItem(first));
}
</script>

<template>
  <AppPage title="Context" description="What agents can be given: systems’ skills and guides, memory, and context made from resources, linked as a graph.">
    <template #actions>
      <UiButton icon="file" data-testid="context-from-resource" @click="making = true">From a resource</UiButton>
      <UiButton variant="primary" icon="plus" data-testid="context-remember" @click="remembering = true">Remember</UiButton>
    </template>
    <div class="filters" data-testid="context-filters">
      <UiInput v-model="search.draft.value" class="search" type="search" icon="search" label="Search context" hide-label placeholder="Search names and descriptions" clearable data-testid="context-search" />
      <UiSegmented v-model="origin" :options="ORIGINS" label="Origin" data-testid="context-origin" />
      <RouterLink v-if="systemText !== ''" class="chip" :to="links.context({ ...(search.value.value === '' ? {} : { q: search.value.value }) })" data-testid="context-system">
        {{ systemText }} <span aria-hidden="true">×</span><span class="sr-only">Show every system</span>
      </RouterLink>
    </div>
    <LoadState
      :loading="context.list.loading.value && !context.list.loaded.value" :problem="context.list.problem.value" :ready="context.list.loaded.value" :empty="items.length === 0"
      :empty-title="filtered ? 'Nothing matches' : 'No context yet'"
      :empty-body="filtered ? 'Try other words, or every origin.' : 'Systems add their skills and guides here; memory and context made from resources join them.'"
      empty-icon="book" @retry="context.show(filter)"
    >
      <ul class="list" :class="{ refreshing: context.list.loading.value }" data-testid="context-list">
        <li v-for="record in items" :key="record.name"><ContextRow :record="record" :to="links.contextItem(record.name)" :now="now" /></li>
      </ul>
      <div v-if="context.list.hasMore.value" class="more">
        <UiButton variant="ghost" :loading="context.list.loadingMore.value" data-testid="more" @click="context.list.more()">Show more</UiButton>
      </div>
    </LoadState>
    <MemoryDialog v-model:open="remembering" :busy="context.remembering.busy.value" :problem="context.remembering.problem.value" @save="remember" />
    <FromResourceDialog
      v-model:open="making" :busy="context.making.busy.value" :problem="context.making.problem.value"
      :found="finder.found.value.value ?? []" :finding="finder.found.loading.value" :find-problem="finder.found.problem.value" @find="finder.search($event)" @save="fromResource"
    />
  </AppPage>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.search { flex: 1 1 260px; min-width: 0; max-width: 420px; }
.chip {
  display: inline-flex; align-items: center; gap: var(--space-1); height: var(--control-sm); padding: 0 var(--space-3); border-radius: var(--radius-full);
  background: var(--accent-soft); color: var(--accent); font-size: var(--text-sm); text-decoration: none;
}
.list {
  display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm);
  list-style: none; overflow: hidden; transition: opacity var(--fast) var(--ease);
}
.list > li + li { border-top: 1px solid var(--border); }
.refreshing { opacity: 0.7; }
.more { display: flex; justify-content: center; }
@media (max-width: 559.98px) {
  .search { max-width: none; flex-basis: 100%; }
}
</style>
