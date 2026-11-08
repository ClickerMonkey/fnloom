/**
 * The JSON viewer's tree: a parsed value flattened into the rows that are showing, given which paths are open. Each
 * row has its depth, its key, a short preview of the value, and its path (`items[2].name`) to copy. Large arrays and
 * objects show their first entries with a "show more" row. JSON Lines read as an array of their lines. Search opens
 * the paths to every match. Pure, so it is tested alone.
 */
import { Json } from '@harness/core';

/** What a value is, for its colour and preview. */
export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** One row of the tree. */
export type JsonRow =
  | {
    readonly kind: 'value';
    readonly path: string;
    readonly depth: number;
    /** The key or index it has in its parent; '' for the root. */
    readonly key: string;
    readonly type: JsonKind;
    /** The value as it reads in one line (`"text"`, `12`, `{ 3 keys }`). */
    readonly preview: string;
    /** Whether it has children (and so can open). */
    readonly branch: boolean;
    readonly open: boolean;
    readonly match: boolean;
  }
  | { readonly kind: 'more'; readonly path: string; readonly depth: number; readonly hidden: number };

/** Entries of an open branch shown before a "show more" row. */
export const PAGE = 100;

/** Whether a value is a JSON object. */
function isObject(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a value is. */
export function kindOf(value: Json): JsonKind {
  if (value === null) { return 'null'; }
  if (Array.isArray(value)) { return 'array'; }
  if (isObject(value)) { return 'object'; }
  return typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean';
}

/** A value in one line. */
export function previewOf(value: Json): string {
  if (Array.isArray(value)) { return value.length === 0 ? '[]' : `[ ${value.length} ${value.length === 1 ? 'item' : 'items'} ]`; }
  if (isObject(value)) {
    const n = Object.keys(value).length;
    return n === 0 ? '{}' : `{ ${n} ${n === 1 ? 'key' : 'keys'} }`;
  }
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

/** The path of a child: `a.b`, `a[2]`, and `a["odd key"]` for a key that isn't an identifier. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') { return `${parent}[${key}]`; }
  if (/^[A-Za-z_$][\w$]*$/.test(key)) { return parent === '' ? key : `${parent}.${key}`; }
  return `${parent}[${JSON.stringify(key)}]`;
}

/** A value's children, as key and value. */
function childrenOf(value: Json): (readonly [string | number, Json])[] {
  if (Array.isArray(value)) { return value.map((item, i) => [i, item] as const); }
  return isObject(value) ? Object.entries(value) : [];
}

/** Whether a value or its key has the search words. */
function matches(key: string, value: Json, search: string): boolean {
  if (search === '') { return false; }
  const scalar = Array.isArray(value) || isObject(value) ? '' : String(value);
  return key.toLowerCase().includes(search) || scalar.toLowerCase().includes(search);
}

/** What the tree shows: which paths are open, how many entries of each open branch, and the search. */
export interface TreeState {
  readonly open: ReadonlySet<string>;
  /** Entries shown per branch path, beyond the first `PAGE`. */
  readonly shown: ReadonlyMap<string, number>;
  readonly search: string;
}

/** The rows showing for a value (open the root with the path ''). Every branch on the way to a search match opens. */
export function treeRows(root: Json, state: TreeState): JsonRow[] {
  const search = state.search.trim().toLowerCase();
  const found = search === '' ? new Set<string>() : matchPaths(root, search);
  const rows: JsonRow[] = [];
  const walk = (value: Json, key: string, path: string, depth: number): void => {
    const branch = Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0;
    const open = branch && (state.open.has(path) || [...found].some((p) => p !== path && isUnder(p, path)));
    rows.push({ kind: 'value', path, depth, key, type: kindOf(value), preview: previewOf(value), branch, open, match: found.has(path) });
    if (!open) { return; }
    const children = childrenOf(value);
    const limit = state.shown.get(path) ?? PAGE;
    for (const [childKey, child] of children.slice(0, limit)) { walk(child, String(childKey), childPath(path, childKey), depth + 1); }
    if (children.length > limit) { rows.push({ kind: 'more', path, depth: depth + 1, hidden: children.length - limit }); }
  };
  walk(root, '', '', 0);
  return rows;
}

/** Whether `path` is inside `parent`. */
function isUnder(path: string, parent: string): boolean {
  if (parent === '') { return path !== ''; }
  return path.startsWith(parent) && (path[parent.length] === '.' || path[parent.length] === '[');
}

/** The paths of every value whose key or value has the search words. */
export function matchPaths(root: Json, search: string): Set<string> {
  const out = new Set<string>();
  const walk = (value: Json, key: string, path: string): void => {
    if (matches(key, value, search)) { out.add(path); }
    for (const [childKey, child] of childrenOf(value)) { walk(child, String(childKey), childPath(path, childKey)); }
  };
  walk(root, '', '');
  return out;
}

/** The value at a path the tree made, or undefined. */
export function valueAt(root: Json, path: string): Json | undefined {
  if (path === '') { return root; }
  const steps = [...path.matchAll(/\.?([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g)];
  let at: Json | undefined = root;
  for (const step of steps) {
    if (at === undefined) { return undefined; }
    const [, name, index, quoted] = step;
    if (index !== undefined) { at = Array.isArray(at) ? at[Number(index)] : undefined; continue; }
    const parsedKey: unknown = quoted === undefined ? name : JSON.parse(quoted);
    const key = typeof parsedKey === 'string' ? parsedKey : '';
    at = at !== null && isObject(at) ? at[key] : undefined;
  }
  return at;
}

/** A JSON document, or JSON Lines as an array of their lines, or why it doesn't read. */
export function parseJson(text: string, lines: boolean): { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly problem: string } {
  try {
    const raw: unknown = lines ? text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line): unknown => JSON.parse(line)) : JSON.parse(text);
    const parsed = Json.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: 'This is not plain JSON.' };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The paths of every branch down to `depth` levels (the root is level 0), to open them all at once. */
export function pathsTo(root: Json, depth: number): Set<string> {
  const paths = new Set<string>(['']);
  const walk = (value: Json, path: string, level: number): void => {
    const children = childrenOf(value);
    if (level >= depth || children.length === 0) { return; }
    paths.add(path);
    for (const [key, child] of children) { walk(child, childPath(path, key), level + 1); }
  };
  walk(root, '', 0);
  return paths;
}
