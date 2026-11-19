<script setup lang="ts">
/**
 * A graph with its search and filters, over one graph query (`v-model`, which the page keeps in its URL): the search
 * bar every list has (`ListSearch list="graph"`: words, filter pills and the filter menu, run by the hub) with the
 * graph's own controls in its slot (focus and hops, collapsed systems, references outside). It asks the hub for that
 * query's page, shows "N nodes / M edges" ("+N more" when the cap cut), and draws it. Opening a fn opens the fn
 * modal; anything else goes to its page (a greyed item to its own system). "Show its neighbourhood" and a stub's
 * "Show them" focus the query on that item. `scoped` is a system's own graph (its system fixed by the parent).
 */
import type { GraphMore, GraphNode, GraphQuery, SystemName } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import LoadState from '../../admin/components/LoadState.vue';
import ListSearch from '../../components/query/ListSearch.vue';
import { useFnModal } from '../../fns/state/fn-modal.ts';
import { useStores } from '../../state/stores.ts';
import type { SearchQuery } from '../../ui/search.ts';
import { expandQuery, openTarget, searchOf, systemsOf, totalsText, withSearch } from '../logic/graph.ts';
import GraphControls from './GraphControls.vue';
import GraphView from './GraphView.vue';

const props = withDefaults(defineProps<{ scoped?: boolean; height?: string | undefined }>(), { scoped: false, height: undefined });
const query = defineModel<GraphQuery>({ required: true });

const { graph } = useStores();
const store = graph();
const router = useRouter();
const page = computed(() => store.page.value.value);
const fnModal = useFnModal();

watch(() => JSON.stringify(query.value), () => { void store.show(query.value); }, { immediate: true });

/** The search bar's words and filters: the graph query's own, its drawing controls kept as they are. */
const search = computed<SearchQuery>({ get: () => searchOf(query.value), set: (next) => { query.value = withSearch(query.value, next); } });

/** Every system seen so far, so the collapse menu keeps offering those filtered out. */
const known = ref<readonly SystemName[]>([]);
watch(page, (shown) => {
  if (shown === undefined) { return; }
  known.value = [...new Set([...known.value, ...systemsOf(shown), ...(query.value.collapse ?? [])])].sort();
});
const focusName = computed(() => page.value?.nodes.find((node) => node.id === query.value.focus?.node)?.name ?? '');
const totals = computed(() => (page.value === undefined ? '' : totalsText(page.value)));

function open(node: GraphNode): void {
  const target = openTarget(node);
  if (target.type === 'fn') { fnModal?.open(target.fn); } else { void router.push(target.to); }
}

function focus(node: GraphNode): void {
  query.value = { ...query.value, focus: { node: node.id, hops: query.value.focus?.hops ?? 1 } };
}

function expand(more: GraphMore): void {
  query.value = expandQuery(query.value, more);
}
</script>

<template>
  <div class="graph-panel" data-testid="graph-panel-root">
    <ListSearch v-model="search" list="graph" label="graph items" placeholder="Search names and descriptions" no-sort>
      <GraphControls v-model="query" :systems="known" :focus-name="focusName" :scoped="props.scoped" />
    </ListSearch>
    <LoadState
      :loading="store.page.loading.value" :problem="store.page.problem.value" :ready="page !== undefined" :empty="page !== undefined && page.nodes.length === 0"
      empty-icon="tree" empty-title="Nothing to draw" empty-body="No items match these filters." :lines="6" @retry="store.refresh()"
    >
      <template v-if="page">
        <p class="totals" data-testid="graph-totals">
          {{ totals }}
        </p>
        <GraphView :page="page" :clusters="!props.scoped" v-bind="props.height === undefined ? {} : { height: props.height }" @open="open" @focus="focus" @expand="expand" />
      </template>
    </LoadState>
  </div>
</template>

<style scoped>
.graph-panel { display: grid; gap: var(--space-2); min-width: 0; }
.totals { margin: 0; font-size: var(--text-xs); color: var(--text-faint); }
</style>
