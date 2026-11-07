/** The `tree` context: a root's folders and files drawn as a tree, bounded in depth and size. */
import type { ResolvedRoot } from './index.ts';
import { collect, type WalkEntry } from './walk.ts';

/** How much of a tree is drawn. */
export interface TreeLimits {
  readonly depth: number;
  /** Most entries drawn per root. */
  readonly entries: number;
  readonly ignore: readonly string[];
}

/** Whether each entry is the last of its siblings, for a walk in depth-first order. */
function lastSiblings(entries: readonly WalkEntry[]): boolean[] {
  return entries.map((entry, i) => {
    for (const later of entries.slice(i + 1)) {
      if (later.depth < entry.depth) { return true; }
      if (later.depth === entry.depth) { return false; }
    }
    return true;
  });
}

/** Draw walk entries as tree lines (`├─ src/`, `│  └─ a.ts`). */
export function drawTree(entries: readonly WalkEntry[]): string[] {
  const last = lastSiblings(entries);
  const open: boolean[] = [];
  return entries.map((entry, i) => {
    const isLast = last[i] ?? true;
    open[entry.depth] = !isLast;
    const indent = Array.from({ length: entry.depth - 1 }, (_, k) => (open[k + 1] === true ? '│  ' : '   ')).join('');
    return `${indent}${isLast ? '└─ ' : '├─ '}${entry.name}${entry.type === 'folder' ? '/' : ''}`;
  });
}

/** One root as a tree, with a header naming it and a note when entries were left out. */
export async function renderTree(root: ResolvedRoot, limits: TreeLimits, signal?: AbortSignal): Promise<string> {
  const found = await collect(root.folder, { ignore: limits.ignore, depth: limits.depth, limit: limits.entries + 1, ...(signal === undefined ? {} : { signal }) });
  const header = `${root.name}/ (${root.folder}${root.writable ? '' : ', read-only'})`;
  const more = found.length > limits.entries ? [`… more entries not shown (the first ${limits.entries}, ${limits.depth} levels deep). Use fs/list or fs/glob for the rest.`] : [];
  // drawn with the one extra entry, so an entry followed by more isn't drawn as the last
  const body = found.length === 0 ? ['(empty)'] : drawTree(found).slice(0, limits.entries);
  return [header, ...body, ...more].join('\n');
}
