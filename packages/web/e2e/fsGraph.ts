/**
 * The fs system's real authoring context as graph nodes (build 8): every item of `systems/fs/context` (a few hundred
 * `authoring.*` parts and topics), with the links its front matter declares (`choices` load the next item, `fns` bring
 * fns in, `parent` and `next`), so the mock hub's graph has a real-sized fs cluster to lay out. Read from the files the
 * fs system serves, so the cluster grows as the guide does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAPH_EDGE_VERBS, GraphEdge, GraphNode, type GraphEdgeKind, type GraphNodeId } from '@harness/core';

const CONTEXT = fileURLToPath(new URL('../../../systems/fs/context/', import.meta.url));

/** Every markdown file under a folder. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.md') ? [join(dir, entry.name)] : []));
}

/** One front matter field's quoted value. */
function field(text: string, name: string): string | undefined {
  return new RegExp(`^${name}: "([^"]*)"`, 'm').exec(text)?.[1];
}

/** The fs authoring cluster: its context nodes and their edges. */
export function fsAuthoringGraph(): { readonly nodes: GraphNode[]; readonly edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const links: [GraphNodeId, GraphEdgeKind, GraphNodeId][] = [];
  for (const file of files(CONTEXT)) {
    const text = readFileSync(file, 'utf8');
    const key = field(text, 'key');
    if (key === undefined) { continue; }
    const id: GraphNodeId = `context:fs/${key}`;
    nodes.push(GraphNode.parse({ id, kind: 'context', name: `fs/${key}`, about: field(text, 'summary') ?? '', system: 'fs', external: false, facts: { on: true, stage: 'live' } }));
    links.push([id, 'belongs', 'system:fs']);
    for (const match of text.matchAll(/^ {2}- to: "([^"]+)"/gm)) { if (match[1] !== undefined) { links.push([id, 'loads', `context:${match[1]}`]); } }
    const fns = /^fns: \[(.*)\]/m.exec(text)?.[1] ?? '';
    for (const match of fns.matchAll(/"([^"]+)"/g)) { if (match[1] === 'fs/read' || match[1] === 'fs/write' || match[1] === 'fs/install_system') { links.push([id, 'brings', `fn:${match[1]}`]); } }
  }
  const known = new Set<string>([...nodes.map((n) => n.id), 'system:fs', 'fn:fs/read', 'fn:fs/write', 'fn:fs/install_system']);
  const name = (id: string): string => id.slice(id.indexOf(':') + 1);
  const edges = links.filter(([from, , to]) => known.has(from) && known.has(to))
    .map(([from, kind, to]) => GraphEdge.parse({ from, to, kind, label: `${name(from)} ${GRAPH_EDGE_VERBS[kind]} ${name(to)}` }));
  return { nodes, edges };
}
