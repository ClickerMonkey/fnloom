<script setup lang="ts">
/**
 * Every context item the person may see (`/context`), searched, filtered and sorted by the hub with the list's query in
 * the URL (`q`: words, origin, system, tags...), page by page. "Context" (`?remember=1`) writes a memory (every other
 * context option folded under Advanced) and "From a resource" (`?from=1`) makes context from one; each opens the item
 * it made. Live: a change to any item refreshes the list quietly.
 */
import type { ContextFromResourceArgs } from '@harness/core';
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import LoadState from '../admin/components/LoadState.vue';
import ContextRow from '../context/components/ContextRow.vue';
import FromResourceDialog from '../context/components/FromResourceDialog.vue';
import MemoryDialog from '../context/components/MemoryDialog.vue';
import ListSearch from '../components/query/ListSearch.vue';
import { filterOf, isFiltered, type MemoryDraft } from '../context/logic/context.ts';
import { hubListQuery, useListQuery } from '../state/query.ts';
import { useStores } from '../state/stores.ts';
import { UiButton } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { context, resources, toasts, chat } = useStores();
const finder = resources.search();
const router = useRouter();
const now = useNow();
const query = useRouteQuery(ROUTES.context);
const search = useListQuery('contexts');
const rememberOpen = query.text('remember', { push: true });
const fromOpen = query.text('from', { push: true });

const remembering = computed({ get: () => rememberOpen.value === '1', set: (isOpen) => { rememberOpen.value = isOpen ? '1' : ''; } });
const making = computed({ get: () => fromOpen.value === '1', set: (isOpen) => { fromOpen.value = isOpen ? '1' : ''; } });

const filter = computed(() => filterOf(hubListQuery(search.value)));
onMounted(() => { void chat.access.load(); });
watch(() => JSON.stringify(filter.value), () => { void context.show(filter.value); }, { immediate: true });
context.follow();

const items = computed(() => context.list.items.value);
const filtered = computed(() => isFiltered(filter.value));

async function remember(draft: MemoryDraft): Promise<void> {
  const result = await context.remember(draft);
  if (!result.ok) { return; }
  // a memory for everyone is everyone's until told otherwise; shared narrows it to the people picked
  if (draft.share.visibility === 'shared') {
    const shared = await chat.access.set({ kind: 'context', context: result.value }, draft.share);
    if (!shared.ok) { toasts.error("Added, but couldn't share it", shared.problem); }
  }
  toasts.ok('Context added', result.value);
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
      <UiButton variant="primary" icon="plus" data-testid="context-remember" @click="remembering = true">Context</UiButton>
    </template>
    <ListSearch v-model="search" list="contexts" label="context" placeholder="Search names and descriptions, or filter" :count="items.length" :more="context.list.hasMore.value" :partial="context.list.partial.value" data-testid="context-filters" />
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
    <MemoryDialog v-model:open="remembering" :multi-user="chat.access.multiUser.value" :busy="context.remembering.busy.value" :problem="context.remembering.problem.value" @save="remember" />
    <FromResourceDialog
      v-model:open="making" :busy="context.making.busy.value" :problem="context.making.problem.value"
      :found="finder.found.value.value ?? []" :finding="finder.found.loading.value" :find-problem="finder.found.problem.value" @find="finder.search($event)" @save="fromResource"
    />
  </AppPage>
</template>

<style scoped>
.list {
  display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm);
  list-style: none; overflow: hidden; transition: opacity var(--fast) var(--ease);
}
.list > li + li { border-top: 1px solid var(--border); }
.refreshing { opacity: 0.7; }
.more { display: flex; justify-content: center; }
</style>
