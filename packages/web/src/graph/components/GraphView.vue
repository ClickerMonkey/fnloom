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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { UiIconButton, UiSpinner } from '../../ui/index.ts';
import { useDarkTheme } from '../../ui/theme.ts';
import { graphElements, kindLabel, moreId, NODE_KIND_COLORS, pickOf, type GraphPick } from '../logic/graph.ts';
import { graphStyle, resolveColors, shapeClip } from '../palette.ts';
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
const panel = ref<HTMLElement | null>(null);
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
/** Room left around the graph when it is framed, clear of the zoom buttons and the legend. */
const FIT_PADDING = 40;
/** The zoom a graph opens at stays in this range, so labels are readable however many items there are. */
const START_ZOOM = { min: 0.65, max: 1.3 } as const;
/** Whether part of the graph lies outside the box (then a hint says so, with a Fit button). */
const cropped = ref(false);
/** The next animation frame the crop check waits for, so a pan checks once per frame. */
let cropCheck = 0;

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
  const layout = core.layout({
    name: 'cose', animate: false, fit: false, nodeDimensionsIncludeLabels: true, padding: 16, componentSpacing: 24, nodeRepulsion: () => 2200, idealEdgeLength: () => 40,
    nestingFactor: 0.8, gravity: 4, nodeOverlap: 8, numIter: 1500,
  });
  layout.one('layoutstop', () => { moved = false; frameView(); });
  layout.run();
}

/**
 * Frame the graph so the first view shows as much as stays readable: the whole graph when it fits at a readable zoom,
 * else the shown systems' own items (references from other systems may fall outside), else the own items centred at
 * the smallest readable zoom. The zoom is clamped only after fitting; whatever is left outside is flagged by a hint.
 */
function frameView(): void {
  const core = cy.value;
  if (core === undefined) { return; }
  core.resize();
  if (core.width() === 0 || core.height() === 0 || core.elements().length === 0) { return; }
  const own = core.nodes().not('.external').not('.more');
  const targets = own.length > 0 && own.length < core.nodes().length ? [core.elements(), own] : [core.elements()];
  for (const target of targets) {
    core.fit(target, FIT_PADDING);
    if (core.zoom() >= START_ZOOM.min) { break; }
  }
  const level = Math.min(START_ZOOM.max, Math.max(START_ZOOM.min, core.zoom()));
  if (level !== core.zoom()) {
    core.zoom(level);
    core.center(own.length > 0 ? own : undefined);
  }
  checkCrop();
}

/** Note whether any element lies outside the box (checked once per frame while panning or zooming). */
function checkCrop(): void {
  if (cropCheck !== 0) { return; }
  cropCheck = requestAnimationFrame(() => {
    cropCheck = 0;
    const core = cy.value;
    if (core === undefined || core.elements().length === 0) { cropped.value = false; return; }
    const box = core.elements().renderedBoundingBox();
    const slack = 2;
    cropped.value = box.x1 < -slack || box.y1 < -slack || box.x2 > core.width() + slack || box.y2 > core.height() + slack;
  });
}

/** Fit everything in view, however small it gets (the Fit button). */
function fitAll(): void {
  cy.value?.fit(undefined, FIT_PADDING);
}

/** Pan so the chosen node sits in the part of the box the details panel leaves free. */
async function keepClear(target: Element): Promise<void> {
  await nextTick();
  const core = cy.value;
  const box = frame.value;
  const sheet = panel.value;
  if (core === undefined || box === null || sheet === null || !target.isNode()) { return; }
  const at = target.renderedPosition();
  const docked = sheet.offsetLeft > box.clientWidth / 2;
  const free = docked ? { x: 0, y: 0, width: sheet.offsetLeft, height: box.clientHeight } : { x: 0, y: 0, width: box.clientWidth, height: sheet.offsetTop };
  const margin = 32;
  const inside = at.x > free.x + margin && at.x < free.x + free.width - margin && at.y > free.y + margin && at.y < free.y + free.height - margin;
  if (inside) { return; }
  core.animate({ panBy: { x: free.x + free.width / 2 - at.x, y: free.y + free.height / 2 - at.y } }, { duration: 200 });
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
      void keepClear(event.target);
      if (pick.type === 'node' && pick.node.kind === 'fn' && !pick.node.external) { emit('open', pick.node); }
    });
    core.on('tap', (event) => { if (event.target === core) { picked.value = undefined; light(undefined); } });
    core.on('pan zoom', () => { hover.value = undefined; checkCrop(); });
    core.on('dragpan scrollzoom pinchzoom', () => { moved = true; });
    resize = new ResizeObserver(() => { core.resize(); if (!moved) { frameView(); } });
    resize.observe(container);
  } catch (error) {
    problem.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  resize?.disconnect();
  cancelAnimationFrame(cropCheck);
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
      <UiIconButton icon="grid" label="Fit to view" size="sm" data-testid="graph-fit" @click="fitAll" />
    </div>
    <button v-if="cropped" type="button" class="cropped" data-testid="graph-cropped" @click="fitAll">More outside the view · Fit all</button>
    <div v-if="hover && !picked" class="hover" :style="hoverStyle" data-testid="graph-hover" role="tooltip">
      <GraphDetails :pick="hover.pick" />
    </div>
    <div v-if="picked" ref="panel" class="panel" data-testid="graph-panel">
      <GraphDetails :pick="picked" actions @open="emit('open', $event)" @focus="emit('focus', $event)" @expand="expand" @close="close" />
    </div>
    <ul class="legend" aria-label="Kinds">
      <li v-for="kind in kinds" :key="kind"><span class="shape" :style="{ background: legendColor(kind), clipPath: shapeClip(kind) }" />{{ kindLabel(kind) }}</li>
      <li class="dim"><span class="dot external" />Outside this view</li>
    </ul>
  </div>
</template>

<style scoped>
.graph { position: relative; container: graph / inline-size; min-height: 320px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.canvas { position: absolute; inset: 0; }
.loading { position: absolute; inset: 0; display: grid; place-items: center; }
.problem { position: absolute; inset: auto var(--space-3) var(--space-3); margin: 0; color: var(--danger); }
.tools { position: absolute; top: var(--space-2); right: var(--space-2); display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.cropped {
  position: absolute; top: var(--space-2); left: var(--space-2); max-width: calc(100% - 120px); padding: 4px var(--space-2); border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--surface); color: var(--text-dim); font: inherit; font-size: var(--text-xs); cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cropped:hover { color: var(--text); border-color: var(--border-strong, var(--accent)); }
.cropped:focus-visible { outline: none; box-shadow: var(--ring); }
.hover, .panel {
  position: absolute; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.hover { pointer-events: none; z-index: 2; }
/* a bottom sheet on a narrow box, docked to the right below the zoom buttons on a wide one; the graph pans the chosen node clear of it */
.panel { left: var(--space-2); right: var(--space-2); bottom: 34px; max-height: 45%; overflow: auto; z-index: 3; }
@container graph (min-width: 720px) {
  .panel { left: auto; top: 48px; bottom: auto; width: 320px; max-height: calc(100% - 90px); }
}
.legend {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: nowrap; scroll-snap-type: x proximity;
  mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); gap: var(--space-3); margin: 0; padding: 4px 32px 4px var(--space-3); list-style: none;
  overflow-x: auto; font-size: var(--text-xs); color: var(--text-dim); background: color-mix(in srgb, var(--surface) 88%, transparent); border-top: 1px solid var(--border);
  white-space: nowrap; scrollbar-width: none;
}
.legend li { display: inline-flex; align-items: center; gap: 4px; }
.shape { width: 11px; height: 11px; flex: none; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.dot.external { border: 1px dashed var(--text-faint); background: transparent; }
.dim { color: var(--text-faint); }
</style>
