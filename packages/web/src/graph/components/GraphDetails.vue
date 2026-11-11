<script setup lang="ts">
/**
 * What a picked graph element is: a node's name, kind, description and key facts with Open and "Show its
 * neighbourhood"; an edge's relation in plain words with both ends to open; a "+N more" stub with Show them. Used as
 * the hover card (compact, no actions) and as the panel a tap or click opens.
 */
import type { GraphNode } from '@harness/core';
import { computed } from 'vue';
import { UiBadge, UiButton, UiIconButton } from '../../ui/index.ts';
import { EDGE_KIND_LABELS, kindLabel, moreLabel, nodeFacts, type GraphPick } from '../logic/graph.ts';

const props = withDefaults(defineProps<{ pick: GraphPick; actions?: boolean }>(), { actions: false });
const emit = defineEmits<{ open: [node: GraphNode]; focus: [node: GraphNode]; expand: []; close: [] }>();

const facts = computed(() => (props.pick.type === 'node' ? nodeFacts(props.pick.node) : []));
</script>

<template>
  <div class="details" :class="{ compact: !actions }" data-testid="graph-details">
    <template v-if="pick.type === 'node'">
      <div class="head">
        <UiBadge :tone="pick.node.external ? 'neutral' : 'accent'">{{ kindLabel(pick.node.kind) }}</UiBadge>
        <span class="name" data-testid="graph-details-name">{{ pick.node.name }}</span>
        <UiIconButton v-if="actions" icon="x" label="Close" size="sm" @click="emit('close')" />
      </div>
      <p v-if="pick.node.about" class="about">{{ pick.node.about }}</p>
      <dl class="facts">
        <div v-for="line in facts" :key="line.label"><dt>{{ line.label }}</dt><dd>{{ line.value }}</dd></div>
      </dl>
      <div v-if="actions" class="actions">
        <UiButton size="sm" variant="primary" data-testid="graph-open" @click="emit('open', pick.node)">{{ pick.node.external ? `Open in ${pick.node.system ?? 'the hub'}` : 'Open' }}</UiButton>
        <UiButton size="sm" data-testid="graph-focus" @click="emit('focus', pick.node)">Show its neighbourhood</UiButton>
      </div>
    </template>
    <template v-else-if="pick.type === 'edge'">
      <div class="head">
        <UiBadge>{{ EDGE_KIND_LABELS[pick.edge.kind] }}</UiBadge>
        <span class="sentence" data-testid="graph-details-name">{{ pick.edge.label }}</span>
        <UiIconButton v-if="actions" icon="x" label="Close" size="sm" @click="emit('close')" />
      </div>
      <p v-if="pick.edge.weight !== undefined" class="about">A learned link, weight {{ pick.edge.weight.toFixed(2) }}.</p>
      <div v-if="actions" class="actions">
        <UiButton v-if="pick.from" size="sm" @click="pick.from && emit('open', pick.from)">Open {{ pick.from.name }}</UiButton>
        <UiButton v-if="pick.to" size="sm" @click="pick.to && emit('open', pick.to)">Open {{ pick.to.name }}</UiButton>
      </div>
    </template>
    <template v-else>
      <div class="head">
        <span class="sentence" data-testid="graph-details-name">{{ moreLabel(pick.more) }} not drawn</span>
        <UiIconButton v-if="actions" icon="x" label="Close" size="sm" @click="emit('close')" />
      </div>
      <p class="about">Show the neighbourhood of the item they hang off to see them.</p>
      <div v-if="actions" class="actions"><UiButton size="sm" variant="primary" @click="emit('expand')">Show them</UiButton></div>
    </template>
  </div>
</template>

<style scoped>
.details { display: grid; gap: var(--space-2); min-width: 0; font-size: var(--text-sm); }
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.name { font-family: var(--mono); font-weight: var(--weight-medium); overflow-wrap: anywhere; flex: 1; min-width: 0; }
.sentence { flex: 1; min-width: 0; overflow-wrap: anywhere; font-weight: var(--weight-medium); }
.about { margin: 0; color: var(--text-dim); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px var(--space-3); margin: 0; }
.facts > div { display: contents; }
.facts dt { color: var(--text-faint); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.compact .facts { font-size: var(--text-xs); }
</style>
