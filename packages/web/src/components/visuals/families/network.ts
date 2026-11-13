/**
 * Links between things, a row per edge: a force graph and a circle (`graph`), a flow (`sankey`, which needs links
 * without a cycle) and a chord diagram (`chord`). Nodes are the distinct from and to values, sized by their links.
 */
import type { GraphSeriesOption, SankeySeriesOption } from 'echarts/charts';
import { bound, chartValue, labelOf, needed, numberOf, tooltip, type ChartBuilder } from '../chart-data.ts';

/** One edge per row (rows without both ends are left out), with the row it came from. */
interface Edge {
  readonly source: string;
  readonly target: string;
  readonly value: number;
  readonly row: number;
}

/** Whether edges go round in a loop (a flow chart can't lay one out). */
export function hasCycle(edges: readonly Pick<Edge, 'source' | 'target'>[]): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) { next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]); }
  const state = new Map<string, 'open' | 'done'>();
  const visit = (node: string): boolean => {
    if (state.get(node) === 'open') { return true; }
    if (state.get(node) === 'done') { return false; }
    state.set(node, 'open');
    const found = (next.get(node) ?? []).some(visit);
    state.set(node, 'done');
    return found;
  };
  return [...next.keys()].some(visit);
}

export const network: ChartBuilder = (input) => {
  const from = needed(input, 'source'); const to = needed(input, 'target'); const weight = bound(input, 'value');
  const edges = input.table.rows.flatMap((row, at): Edge[] => {
    const source = chartValue(row[from.index]); const target = chartValue(row[to.index]);
    if (source === null || target === null) { return []; }
    return [{ source: labelOf(source), target: labelOf(target), value: weight === undefined ? 1 : numberOf(row[weight.index]) ?? 0, row: at }];
  });
  const degree = new Map<string, number>();
  for (const edge of edges) { for (const end of [edge.source, edge.target]) { degree.set(end, (degree.get(end) ?? 0) + 1); } }
  const most = Math.max(1, ...degree.values());
  const nodes = [...degree.entries()].map(([name, links]) => ({ name, value: links, symbolSize: 8 + (links / most) * 24 }));
  const links = edges.map((edge) => ({ source: edge.source, target: edge.target, value: edge.value }));
  const rowOf = (click: { readonly dataType?: string | undefined; readonly dataIndex?: number | undefined }): number | undefined =>
    (click.dataType === 'edge' && click.dataIndex !== undefined ? edges[click.dataIndex]?.row : undefined);
  const points = nodes.length + links.length;

  if (input.style === 'sankey') {
    if (hasCycle(edges)) { return { problem: 'These links go round in a loop, so they can’t be drawn as a flow. Try Graph or Chord.' }; }
    const flow: SankeySeriesOption = { type: 'sankey', data: nodes.map(({ name }) => ({ name })), links, left: 8, right: input.phone ? 48 : 96, top: 8, bottom: 8, emphasis: { focus: 'adjacency' }, lineStyle: { color: 'gradient', opacity: 0.35 }, label: { color: input.palette.text } };
    return {
      option: { tooltip: tooltip('item'), series: [flow] },
      rowOf, points,
    };
  }
  if (input.style === 'chord') {
    return {
      // every node named on its arc (smaller on a phone) and coloured from the palette; links take their source's colour
      option: {
        tooltip: tooltip('item'),
        series: [{
          type: 'chord', data: nodes.map(({ name }, i) => ({ name, itemStyle: { color: input.palette.series[i % input.palette.series.length] ?? input.palette.text } })), links,
          radius: input.phone ? ['52%', '58%'] : ['62%', '68%'], center: ['50%', '50%'],
          label: { show: nodes.length <= 40, position: 'outside', color: input.palette.text, fontSize: input.phone ? 10 : 12 }, lineStyle: { color: 'source', opacity: 0.4 },
        }],
      },
      rowOf, points,
    };
  }
  const circular = input.style === 'circular';
  const graph: GraphSeriesOption = {
    type: 'graph', layout: circular ? 'circular' : 'force', roam: true, data: nodes, links, edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 6,
    ...(circular ? { circular: { rotateLabel: true } } : { force: { repulsion: 120, edgeLength: [40, 120], gravity: 0.1 } }),
    label: { show: nodes.length <= 40, position: 'right', color: input.palette.text }, lineStyle: { color: input.palette.muted, opacity: 0.5, curveness: circular ? 0.2 : 0 },
    emphasis: { focus: 'adjacency' },
  };
  return {
    option: { tooltip: tooltip('item'), series: [graph] },
    rowOf, points,
  };
};
