<script setup lang="ts">
/**
 * A graph of systems' items drawn with Cytoscape.js (loaded on first use): a cluster per system, references outside
 * the view greyed, "+N more" stubs, laid out by the built-in force layout. Pan and zoom by drag, wheel or pinch;
 * hovering a node or an edge shows what it is and lights its neighbours; a click or tap opens the details panel with
 * Open (a fn opens in the fn modal, through `open`) and "Show its neighbourhood" (`focus`); a stub asks to `expand`.
 * It follows light and dark, and fits again when its box changes size.
 */
import type { GraphMore, GraphNode, GraphPage } from '@harness/core';
import type { Core, EdgeSingular, EventObjectEdge, EventObjectNode, NodeSingular } from 'cytoscape';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { UiIconButton, UiSpinner } from '../../ui/index.ts';
import { useDarkTheme } from '../../ui/theme.ts';
import { graphElements, kindLabel, moreId, NODE_KIND_COLORS, pickOf, type GraphPick } from '../logic/graph.ts';
import { graphStyle, resolveColors } from '../palette.ts';
import GraphDetails from './GraphDetails.vue';

const props = withDefaults(defineProps<{
  page: GraphPage;
  /** Draw a cluster around each system even when only one shows. */
  clusters?: boolean;
  /** The frame's height (any CSS length). */
  height?: string;
}>(), { clusters: false, height: 'min(70vh, 720px)' });
const emit = defineEmits<{ open: [node: GraphNode]; focus: [node: GraphNode]; expand: [more: GraphMore] }>();

const frame = ref<HTMLElement | null>(null);
const canvas = ref<HTMLElement | null>(null);
const cy = shallowRef<Core | undefined>(undefined);
const problem = ref('');
const dark = useDarkTheme();
/** What the pointer is over, and where (in the frame's pixels). */
const hover = shallowRef<{ readonly pick: GraphPick; readonly x: number; readonly y: number } | undefined>(undefined);
const picked = shallowRef<GraphPick | undefined>(undefined);
let resize: ResizeObserver | undefined;
/** A node or an edge, as the graph library hands it over. */
type Element = NodeSingular | EdgeSingular;
/** An event on a node or an edge (the handlers below are bound with the selector `node, edge`). */
type ElementEvent = EventObjectNode | EventObjectEdge;
/** Whether the person panned or zoomed since the last layout (then a resize keeps their view). */
let moved = false;

const kinds = computed(() => [...new Set(props.page.nodes.map((node) => node.kind))]);
const legendColor = (kind: GraphNode['kind']): string => NODE_KIND_COLORS[kind][dark.value ? 1 : 0];
const hoverStyle = computed(() => {
  const at = hover.value;
  const box = frame.value;
  if (at === undefined || box === null) { return {}; }
  const width = Math.min(300, box.clientWidth - 16);
  const left = Math.max(8, Math.min(at.x + 14, box.clientWidth - width - 8));
  const top = at.y + 14 + 160 > box.clientHeight ? Math.max(8, at.y - 170) : at.y + 14;
  return { left: `${left}px`, top: `${top}px`, width: `${width}px` };
});

/** Light an element's neighbourhood and fade the rest. */
function light(target: Element | undefined): void {
  const core = cy.value;
  if (core === undefined) { return; }
  core.elements().removeClass('lit faded');
  if (target === undefined) { return; }
  const near = target.isNode() ? target.closedNeighborhood() : target.connectedNodes().union(target);
  core.elements().not(near).not('node.cluster').addClass('faded');
  near.addClass('lit');
}

function draw(): void {
  const core = cy.value;
  if (core === undefined) { return; }
  hover.value = undefined;
  picked.value = undefined;
  core.elements().remove();
  core.add(graphElements(props.page, { clusters: props.clusters }));
  core.layout({
    name: 'cose', animate: false, nodeDimensionsIncludeLabels: true, padding: 16, componentSpacing: 24, nodeRepulsion: () => 2800, idealEdgeLength: () => 46,
    nestingFactor: 0.9, gravity: 2.5, nodeOverlap: 8, numIter: 1500,
  }).run();
  moved = false;
  core.fit(undefined, 16);
}

function restyle(): void {
  const core = cy.value;
  if (core === undefined || canvas.value === null) { return; }
  core.style(graphStyle(resolveColors(canvas.value), dark.value));
}

onMounted(async () => {
  try {
    const { default: cytoscape } = await import('cytoscape');
    const container = canvas.value;
    if (container === null) { return; }
    const core = cytoscape({ container, minZoom: 0.15, maxZoom: 3, boxSelectionEnabled: false, selectionType: 'single', autoungrabify: false });
    cy.value = core;
    restyle();
    draw();
    core.on('mouseover', 'node, edge', (event: ElementEvent) => {
      const pick = pickOf(props.page, event.target.id());
      if (pick === undefined || event.target.hasClass('cluster')) { return; }
      const at = event.target.isNode() ? event.target.renderedPosition() : event.target.renderedMidpoint();
      hover.value = { pick, x: at.x, y: at.y };
      light(event.target);
    });
    core.on('mouseout', 'node, edge', () => { hover.value = undefined; light(picked.value === undefined ? undefined : core.$id(idOf(picked.value))); });
    core.on('tap', 'node, edge', (event: ElementEvent) => {
      if (event.target.hasClass('cluster')) { return; }
      const pick = pickOf(props.page, event.target.id());
      if (pick === undefined) { return; }
      hover.value = undefined;
      picked.value = pick;
      light(event.target);
      if (pick.type === 'node' && pick.node.kind === 'fn' && !pick.node.external) { emit('open', pick.node); }
    });
    core.on('tap', (event) => { if (event.target === core) { picked.value = undefined; light(undefined); } });
    core.on('pan zoom', () => { hover.value = undefined; });
    core.on('dragpan scrollzoom pinchzoom', () => { moved = true; });
    resize = new ResizeObserver(() => { core.resize(); if (!moved) { core.fit(undefined, 16); } });
    resize.observe(container);
  } catch (error) {
    problem.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  resize?.disconnect();
  cy.value?.destroy();
  cy.value = undefined;
});

watch(() => props.page, draw);
watch(dark, restyle);

/** The element id a pick stands for. */
function idOf(pick: GraphPick): string {
  if (pick.type === 'node') { return pick.node.id; }
  if (pick.type === 'more') { return moreId(pick.more); }
  return cy.value?.edges().filter((edge) => edge.data('source') === pick.edge.from && edge.data('target') === pick.edge.to && edge.data('kind') === pick.edge.kind).first().id() ?? '';
}

function zoomBy(factor: number): void {
  const core = cy.value;
  if (core === undefined) { return; }
  core.zoom({ level: core.zoom() * factor, renderedPosition: { x: core.width() / 2, y: core.height() / 2 } });
}

function close(): void {
  picked.value = undefined;
  light(undefined);
}

function expand(): void {
  if (picked.value?.type === 'more') { emit('expand', picked.value.more); }
}
</script>

<template>
  <div ref="frame" class="graph" :style="{ height }" data-testid="graph-view">
    <div ref="canvas" class="canvas" data-testid="graph-canvas" :aria-label="`Graph of ${page.nodes.length} items and ${page.edges.length} links`" role="img" />
    <div v-if="cy === undefined && problem === ''" class="loading"><UiSpinner /></div>
    <p v-if="problem" class="problem">The graph didn't draw: {{ problem }}</p>
    <div class="tools">
      <UiIconButton icon="plus" label="Zoom in" size="sm" @click="zoomBy(1.3)" />
      <UiIconButton icon="minus" label="Zoom out" size="sm" @click="zoomBy(1 / 1.3)" />
      <UiIconButton icon="grid" label="Fit to view" size="sm" data-testid="graph-fit" @click="cy?.fit(undefined, 16)" />
    </div>
    <div v-if="hover && !picked" class="hover" :style="hoverStyle" data-testid="graph-hover" role="tooltip">
      <GraphDetails :pick="hover.pick" />
    </div>
    <div v-if="picked" class="panel" data-testid="graph-panel">
      <GraphDetails :pick="picked" actions @open="emit('open', $event)" @focus="emit('focus', $event)" @expand="expand" @close="close" />
    </div>
    <ul class="legend" aria-label="Kinds">
      <li v-for="kind in kinds" :key="kind"><span class="dot" :style="{ background: legendColor(kind) }" />{{ kindLabel(kind) }}</li>
      <li class="dim"><span class="dot external" />Outside this view</li>
    </ul>
  </div>
</template>

<style scoped>
.graph { position: relative; min-height: 320px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.canvas { position: absolute; inset: 0; }
.loading { position: absolute; inset: 0; display: grid; place-items: center; }
.problem { position: absolute; inset: auto var(--space-3) var(--space-3); margin: 0; color: var(--danger); }
.tools { position: absolute; top: var(--space-2); right: var(--space-2); display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.hover, .panel {
  position: absolute; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.hover { pointer-events: none; z-index: 2; }
.panel { left: var(--space-2); bottom: 34px; width: min(340px, calc(100% - 2 * var(--space-2))); max-height: calc(100% - 80px); overflow: auto; z-index: 3; }
.legend {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: nowrap; gap: var(--space-3); margin: 0; padding: 4px var(--space-3); list-style: none;
  overflow-x: auto; font-size: var(--text-xs); color: var(--text-dim); background: color-mix(in srgb, var(--surface) 88%, transparent); border-top: 1px solid var(--border);
  white-space: nowrap; scrollbar-width: none;
}
.legend li { display: inline-flex; align-items: center; gap: 4px; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dot.external { border: 1px dashed var(--text-faint); background: transparent; }
.dim { color: var(--text-faint); }
</style>
