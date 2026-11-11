<script setup lang="ts">
/**
 * A graph with its search and filters, over one graph query (`v-model`, which the page keeps in its URL): it asks the
 * hub for that query's page, shows the totals ("+N more" when the cap cut), and draws it. Opening a fn opens the fn
 * modal; anything else goes to its page (a greyed item to its own system). "Show its neighbourhood" and a stub's
 * "Show them" focus the query on that item. `scoped` is a system's own graph (its system fixed by the parent).
 */
import type { FnKindName, GraphMore, GraphNode, GraphQuery, QualifiedName, SystemName } from '@harness/core';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { links } from '../../app/routes.ts';
import LoadState from '../../admin/components/LoadState.vue';
import FnModal from '../../fns/components/FnModal.vue';
import { useStores } from '../../state/stores.ts';
import { expandQuery, openTarget, systemsOf } from '../logic/graph.ts';
import GraphFilters from './GraphFilters.vue';
import GraphView from './GraphView.vue';

const props = withDefaults(defineProps<{ scoped?: boolean; height?: string | undefined }>(), { scoped: false, height: undefined });
const query = defineModel<GraphQuery>({ required: true });

const { graph, session } = useStores();
const store = graph();
const router = useRouter();
const page = computed(() => store.page.value.value);
const fnOpen = ref<QualifiedName | undefined>(undefined);
const isAdmin = computed(() => session.user.value?.role === 'admin');

watch(() => JSON.stringify(query.value), () => { void store.show(query.value); }, { immediate: true });

/** Every system seen so far, so the pickers keep offering those filtered out. */
const known = ref<readonly SystemName[]>([]);
watch(page, (shown) => {
  if (shown === undefined) { return; }
  known.value = [...new Set([...known.value, ...systemsOf(shown), ...(query.value.systems ?? [])])].sort();
});
const fnKinds = computed<readonly FnKindName[]>(() => {
  const named = (page.value?.nodes ?? []).flatMap((node) => (node.kind === 'fn' && node.facts.fnKind !== undefined ? [node.facts.fnKind] : []));
  const plain: FnKindName = 'native';
  return [...new Set([plain, ...named, ...(query.value.fnKinds ?? [])])];
});
const focusName = computed(() => page.value?.nodes.find((node) => node.id === query.value.focus?.node)?.name ?? '');
const cut = computed(() => {
  const shown = page.value;
  return shown === undefined ? 0 : shown.total.nodes - shown.nodes.length;
});

function open(node: GraphNode): void {
  const target = openTarget(node);
  if (target.type === 'fn') { fnOpen.value = target.fn; } else { void router.push(target.to); }
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
    <GraphFilters v-model="query" :systems="known" :fn-kinds="fnKinds" :focus-name="focusName" :scoped="props.scoped" />
    <LoadState
      :loading="store.page.loading.value" :problem="store.page.problem.value" :ready="page !== undefined" :empty="page !== undefined && page.nodes.length === 0"
      empty-icon="tree" empty-title="Nothing to draw" empty-body="No items match these filters." :lines="6" @retry="store.refresh()"
    >
      <template v-if="page">
        <p class="totals" data-testid="graph-totals">
          {{ page.nodes.length }} items, {{ page.edges.length }} links<template v-if="cut > 0">, {{ cut }} more not drawn (open a "+N" to see them)</template>
        </p>
        <GraphView :page="page" :clusters="!props.scoped" v-bind="props.height === undefined ? {} : { height: props.height }" @open="open" @focus="focus" @expand="expand" />
      </template>
    </LoadState>
    <FnModal v-if="fnOpen" v-model:fn="fnOpen" :can-open-page="isAdmin" @page="router.push(links.fn($event))" />
  </div>
</template>

<style scoped>
.graph-panel { display: grid; gap: var(--space-2); min-width: 0; }
.totals { margin: 0; font-size: var(--text-xs); color: var(--text-faint); }
</style>
