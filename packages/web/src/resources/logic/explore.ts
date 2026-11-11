/**
 * The file explorer's addresses. A page's path is a root's name and the folders under it
 * (`/explore/fs/main/work/src/app`); the opened file is the `open` query, its name in that folder. A folder's uri is
 * its root's uri and the path under it, written as the system writes its entries' uris, so a path read off an entry
 * leads back to the same uri. Pure, so it is tested alone.
 */
import { ResourceUri, type ResourceRoot, type ResourceStat } from '@harness/core';

/** A root's uri with exactly one slash at its end, so paths join it with no doubled or missing slash. */
function base(root: ResourceRoot): string {
  return `${root.uri.replace(/\/+$/, '')}/`;
}

/** The uri of a folder (or file) `path` segments under `root`. */
export function uriUnder(root: ResourceRoot, path: readonly string[]): ResourceUri {
  return ResourceUri.parse(path.length === 0 ? root.uri : `${base(root)}${path.join('/')}`);
}

/** The segments of `uri` under `root`, or undefined when it isn't under it. */
export function pathUnder(root: ResourceRoot, uri: string): string[] | undefined {
  const prefix = base(root);
  if (uri === root.uri || `${uri}/` === prefix) { return []; }
  if (!uri.startsWith(prefix)) { return undefined; }
  return uri.slice(prefix.length).replace(/\/+$/, '').split('/').filter((part) => part !== '');
}

/** An entry's own name in its folder, the last segment of its uri (what `open` holds). */
export function entryName(uri: string): string {
  return uri.replace(/\/+$/, '').split('/').at(-1) ?? '';
}

/** Where a page is: the root it is in (by name, first segment of the path) and the folders under it. */
export interface ExplorePlace {
  readonly root: ResourceRoot | undefined;
  readonly path: readonly string[];
}

/** Read a page's path against the instance's roots: the first segment names the root. */
export function placeOf(roots: readonly ResourceRoot[], segments: readonly string[]): ExplorePlace {
  const [first, ...rest] = segments;
  const root = first === undefined ? undefined : roots.find((r) => r.name === first);
  return { root, path: root === undefined ? [] : rest };
}

/** Folders first, then files, each by name as people sort them (`file2` before `file10`). */
export function sortEntries(entries: readonly ResourceStat[]): ResourceStat[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...entries].sort((a, b) => Number(b.type === 'folder') - Number(a.type === 'folder') || collator.compare(a.name, b.name));
}

/** The trail from the root to the folder: each crumb's label and its path. */
export function crumbsOf(root: ResourceRoot, path: readonly string[]): { readonly label: string; readonly path: readonly string[] }[] {
  return [{ label: root.name, path: [] }, ...path.map((part, at) => ({ label: segmentLabel(part), path: path.slice(0, at + 1) }))];
}

/** A path segment as people read it: percent-escapes decoded, kept as written when they don't decode. */
export function segmentLabel(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

/** A folder's subfolders as the explorer's tree needs them. */
export interface ExploreChildren {
  readonly folders: readonly ResourceStat[];
  readonly loading: boolean;
  readonly problem: string;
}
