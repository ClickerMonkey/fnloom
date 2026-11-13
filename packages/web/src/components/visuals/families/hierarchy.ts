/**
 * A tree from a name column and its parent column: a tree and a radial tree (`tree`), a treemap (`treemap`) and a
 * sunburst (`sunburst`), sized by a measure (each leaf counts 1 without one). Rows whose parent is empty or names no
 * row are the roots; several roots hang under one "All" in the trees.
 */
import { bound, chartValue, labelOf, needed, numberOf, tooltip, type ChartBuilder } from '../chart-data.ts';

/** A node of the tree, with the row it came from. */
export interface TreeNode {
  name: string;
  value?: number;
  row: number;
  children: TreeNode[];
}

/** The roots of the tree the rows make (a row whose parent is itself or forms a loop is a root, so nothing is lost). */
export function treeOf(rows: readonly { readonly name: string; readonly parent: string | null; readonly value: number | null }[]): TreeNode[] {
  const nodes = rows.map((row, at): TreeNode => ({ name: row.name, row: at, children: [], ...(row.value === null ? {} : { value: row.value }) }));
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const roots: TreeNode[] = [];
  rows.forEach((row, at) => {
    const node = nodes[at];
    if (node === undefined) { return; }
    const parent = row.parent === null ? undefined : byName.get(row.parent);
    let up = parent; let loops = false;
    for (let steps = 0; up !== undefined && steps <= rows.length; steps++) {
      if (up === node) { loops = true; break; }
      const above = rows[up.row]?.parent;
      up = above === null || above === undefined ? undefined : byName.get(above);
    }
    if (parent === undefined || loops) { roots.push(node); } else { parent.children.push(node); }
  });
  return roots;
}

export const hierarchy: ChartBuilder = (input) => {
  const name = needed(input, 'name'); const parent = needed(input, 'parent'); const size = bound(input, 'value');
  const roots = treeOf(input.table.rows.map((row) => {
    const up = chartValue(row[parent.index]);
    return { name: labelOf(chartValue(row[name.index])), parent: up === null || up === '' ? null : labelOf(up), value: size === undefined ? null : numberOf(row[size.index]) };
  }));
  const leafOne = (nodes: TreeNode[]): TreeNode[] => nodes.map((node) => (node.children.length === 0 && node.value === undefined ? { ...node, value: 1 } : { ...node, children: leafOne(node.children) }));
  const rowByName = new Map(input.table.rows.map((row, at) => [labelOf(chartValue(row[name.index])), at]));
  const rowOf = (click: { readonly name?: string | undefined }): number | undefined => (click.name === undefined ? undefined : rowByName.get(click.name));
  const points = input.table.rows.length;
  const text = { color: input.palette.text };

  if (input.style === 'treemap' || input.style === 'sunburst') {
    const data = leafOne(roots);
    const series = input.style === 'treemap'
      ? [{ type: 'treemap' as const, data, roam: false, left: 4, right: 4, top: 4, bottom: 28, label: { show: true }, upperLabel: { show: !input.phone, height: 20, color: input.palette.text }, breadcrumb: { show: true, bottom: 0, itemStyle: { color: input.palette.grid, textStyle: text } }, levels: [{ itemStyle: { borderColor: input.palette.surface, borderWidth: 2, gapWidth: 2 } }, { colorSaturation: [0.35, 0.6], itemStyle: { borderColorSaturation: 0.7, gapWidth: 1, borderWidth: 1 } }] }]
      : [{ type: 'sunburst' as const, data, radius: ['12%', '92%'], label: { show: !input.phone, rotate: 'radial' as const, color: input.palette.text }, itemStyle: { borderColor: input.palette.surface, borderWidth: 1 } }];
    return { option: { tooltip: tooltip('item'), series }, rowOf, points };
  }

  const [only] = roots;
  const root: TreeNode = roots.length === 1 && only !== undefined ? only : { name: 'All', row: -1, children: roots };
  const radial = input.style === 'radial';
  return {
    option: {
      tooltip: tooltip('item'),
      series: [{
        type: 'tree', data: [root], layout: radial ? 'radial' : 'orthogonal', roam: true, initialTreeDepth: input.phone ? 2 : 3, symbolSize: 8,
        left: radial ? '12%' : 8, right: radial ? '12%' : input.phone ? 72 : 120, top: radial ? '12%' : 8, bottom: radial ? '12%' : 8,
        label: { ...text, position: radial ? 'inside' : 'left', fontSize: 12 }, leaves: { label: { position: radial ? 'inside' : 'right' } }, lineStyle: { color: input.palette.grid },
        expandAndCollapse: true,
      }],
    },
    rowOf, points,
  };
};
