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

/** A tree node with the colour it is drawn in. */
export interface ColouredNode extends Omit<TreeNode, 'children'> {
  children: ColouredNode[];
  itemStyle?: { color: string };
}

/** A node and everything under it in one colour (the sunburst's levels lighten the deeper rings). */
function paint(node: TreeNode, colour: string | undefined): ColouredNode {
  const children = node.children.map((child) => paint(child, colour));
  return colour === undefined ? { ...node, children } : { ...node, children, itemStyle: { color: colour } };
}

/** A sunburst's nodes coloured by their top-level branch from the palette, each branch's descendants in its colour. */
export function byBranch(roots: readonly TreeNode[], colours: readonly string[]): ColouredNode[] {
  return roots.map((node, i) => paint(node, colours[i % Math.max(1, colours.length)]));
}

/**
 * The tree sized for area charts: a leaf without a value counts 1, and a branch is at least the sum of its children (a
 * branch's own smaller or missing value would otherwise hide or squeeze them).
 */
export function sized(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.children.length === 0) { return { ...node, value: node.value ?? 1 }; }
    const children = sized(node.children);
    const sum = children.reduce((total, child) => total + (child.value ?? 0), 0);
    return { ...node, children, value: Math.max(node.value ?? 0, sum) };
  });
}

/** The rings a sunburst draws: one root's children (the root is the centre, so its ring would be a plain disc), else the roots. */
export function rings(roots: readonly TreeNode[]): readonly TreeNode[] {
  const [only] = roots;
  return roots.length === 1 && only !== undefined && only.children.length > 0 ? only.children : roots;
}

export const hierarchy: ChartBuilder = (input) => {
  const name = needed(input, 'name'); const parent = needed(input, 'parent'); const size = bound(input, 'value');
  const roots = treeOf(input.table.rows.map((row) => {
    const up = chartValue(row[parent.index]);
    return { name: labelOf(chartValue(row[name.index])), parent: up === null || up === '' ? null : labelOf(up), value: size === undefined ? null : numberOf(row[size.index]) };
  }));
  const rowByName = new Map(input.table.rows.map((row, at) => [labelOf(chartValue(row[name.index])), at]));
  const rowOf = (click: { readonly name?: string | undefined }): number | undefined => (click.name === undefined ? undefined : rowByName.get(click.name));
  const points = input.table.rows.length;
  const text = { color: input.palette.text };

  if (input.style === 'treemap' || input.style === 'sunburst') {
    const data = sized(roots);
    const series = input.style === 'treemap'
      ? [{ type: 'treemap' as const, data, roam: false, left: 4, right: 4, top: 4, bottom: 28, label: { show: true }, upperLabel: { show: !input.phone, height: 20, color: input.palette.text }, breadcrumb: { show: true, bottom: 0, itemStyle: { color: input.palette.grid, textStyle: text } }, levels: [{ itemStyle: { borderColor: input.palette.surface, borderWidth: 2, gapWidth: 2 } }, { colorSaturation: [0.35, 0.6], itemStyle: { borderColorSaturation: 0.7, gapWidth: 1, borderWidth: 1 } }] }]
      : [{
        type: 'sunburst' as const, data: byBranch(rings(data), input.palette.series), radius: ['18%', '92%'], nodeClick: false as const,
        // each top-level branch takes a palette colour its children inherit; labels sit inside each segment, in the ground's colour on the palette's fills; tiny segments drop theirs
        label: { show: true, rotate: 'radial' as const, color: input.palette.surface, fontSize: input.phone ? 9 : 11, minAngle: input.phone ? 12 : 8 },
        itemStyle: { borderColor: input.palette.surface, borderWidth: 1 },
        levels: [{}, { itemStyle: { opacity: 1 } }, { itemStyle: { opacity: 0.72 } }, { itemStyle: { opacity: 0.5 } }],
      }];
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
