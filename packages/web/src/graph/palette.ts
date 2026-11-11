/**
 * The graph's colours: the app's tokens resolved to plain colours in the element's own theme (the graph library reads
 * only plain colours, not `light-dark()` or `oklch()`), and the stylesheet drawn with them, so the graph follows light
 * and dark with the rest of the app.
 */
import { GRAPH_NODE_KINDS } from '@harness/core';
import type { StylesheetJson } from 'cytoscape';
import { NODE_KIND_COLORS } from './logic/graph.ts';

/** The tokens the graph draws with. */
const TOKENS = { text: '--text', dim: '--text-dim', faint: '--text-faint', border: '--border', strong: '--border-strong', surface: '--surface', surface2: '--surface-2', accent: '--accent', warn: '--warn' } as const;

/** The tokens, resolved. */
export type GraphColors = { readonly [K in keyof typeof TOKENS]: string };

/** Resolve the app's tokens to plain `rgb()` colours as they apply inside `within`. */
export function resolveColors(within: HTMLElement): GraphColors {
  const doc = within.ownerDocument;
  const probe = doc.createElement('span');
  probe.style.display = 'none';
  within.append(probe);
  const canvas = doc.createElement('canvas').getContext('2d');
  const plain = (token: string): string => {
    probe.style.color = `var(${token})`;
    const computed = doc.defaultView?.getComputedStyle(probe).color ?? '';
    if (canvas === null || computed === '') { return computed === '' ? '#888888' : computed; }
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = computed;
    canvas.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = canvas.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
  const colors: GraphColors = {
    text: plain(TOKENS.text), dim: plain(TOKENS.dim), faint: plain(TOKENS.faint), border: plain(TOKENS.border), strong: plain(TOKENS.strong),
    surface: plain(TOKENS.surface), surface2: plain(TOKENS.surface2), accent: plain(TOKENS.accent), warn: plain(TOKENS.warn),
  };
  probe.remove();
  return colors;
}

/** Each node kind's shape. */
const SHAPES = {
  system: 'hexagon', instance: 'round-hexagon', fn: 'ellipse', context: 'round-rectangle', type: 'diamond', kind: 'round-tag', resource: 'barrel',
  root: 'round-triangle', component: 'round-rectangle', registry: 'barrel', command: 'round-triangle', provider: 'round-pentagon',
} as const;

/** The stylesheet the graph draws with, in light or dark. */
export function graphStyle(colors: GraphColors, dark: boolean): StylesheetJson {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)', 'font-size': 11, 'font-family': 'ui-sans-serif, system-ui, sans-serif', color: colors.text, 'text-valign': 'bottom', 'text-margin-y': 4,
        'text-wrap': 'ellipsis', 'text-max-width': '120px', width: 24, height: 24, 'border-width': 2, 'border-color': colors.surface, 'min-zoomed-font-size': 7,
        'text-background-color': colors.surface, 'text-background-opacity': 0.7, 'text-background-padding': '1px', 'text-background-shape': 'roundrectangle',
      },
    },
    ...GRAPH_NODE_KINDS.map((kind) => ({ selector: `node.kind-${kind}`, style: { 'background-color': NODE_KIND_COLORS[kind][dark ? 1 : 0], shape: SHAPES[kind] } })),
    { selector: 'node.kind-system', style: { width: 30, height: 30, 'font-weight': 600 } },
    {
      selector: 'node.cluster',
      style: {
        shape: 'round-rectangle', 'background-color': colors.surface2, 'background-opacity': 0.55, 'border-width': 1, 'border-color': colors.border, label: 'data(label)',
        'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4, 'font-size': 12, 'font-weight': 600, color: colors.dim, padding: '14px', 'text-background-opacity': 0,
      },
    },
    { selector: 'node.cluster.external', style: { 'border-style': 'dashed', 'background-opacity': 0.2 } },
    { selector: 'node.external', style: { opacity: 0.45, 'border-style': 'dashed', 'border-color': colors.faint } },
    { selector: 'node.off', style: { 'background-opacity': 0.35 } },
    { selector: 'node.pending', style: { 'border-color': colors.warn, 'border-width': 3 } },
    { selector: 'node.collapsed', style: { width: 46, height: 46, 'font-size': 12 } },
    {
      selector: 'node.more',
      style: {
        shape: 'round-rectangle', 'background-color': colors.surface2, 'border-width': 1, 'border-style': 'dashed', 'border-color': colors.strong, color: colors.dim,
        'text-valign': 'center', 'text-margin-y': 0, width: 'label', height: 20, padding: '6px', 'font-size': 10, 'text-background-opacity': 0,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5, 'line-color': colors.strong, 'target-arrow-color': colors.strong, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier',
      },
    },
    { selector: 'edge.weighted', style: { 'line-style': 'dashed' } },
    { selector: 'edge.edge-belongs', style: { 'line-style': 'dotted', opacity: 0.4, 'target-arrow-shape': 'none' } },
    { selector: 'edge.edge-more', style: { 'line-style': 'dashed', opacity: 0.6, 'target-arrow-shape': 'none' } },
    { selector: '.faded', style: { opacity: 0.3 } },
    { selector: 'node.lit, node:selected', style: { 'border-color': colors.accent, 'border-width': 3, opacity: 1 } },
    { selector: 'edge.lit, edge:selected', style: { 'line-color': colors.accent, 'target-arrow-color': colors.accent, width: 2.5, opacity: 1 } },
  ];
}
