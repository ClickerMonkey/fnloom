/**
 * Paths: the guard that keeps every fn inside the configured roots, and the conversions between paths, roots and
 * `file://` resource URIs.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ResourceUri } from '@harness/core';
import type { FsRoot, Located, PathGuard, ResolvedRoot } from './index.ts';
import { FsProblem } from './problem.ts';

/** An absolute path with forward slashes and no trailing slash (except a drive or filesystem root). */
export function normalize(path: string): string {
  const slashed = resolve(path).replaceAll('\\', '/');
  return slashed.length > 1 && slashed.endsWith('/') && !/^[A-Za-z]:\/$/.test(slashed) ? slashed.slice(0, -1) : slashed;
}

/** The part of `target` inside `folder` (`''` for the folder itself), or `undefined` when it is outside. */
export function inside(folder: string, target: string): string | undefined {
  const rel = relative(folder, target);
  if (rel === '') { return ''; }
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) { return undefined; }
  return rel.replaceAll('\\', '/');
}

/** The `file://` URI of an absolute path. */
export function fileUri(path: string): ResourceUri {
  return ResourceUri.parse(pathToFileURL(path).href);
}

/** The absolute path of a `file://` URI, or `undefined` for any other scheme. */
export function uriPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) { return undefined; }
  try {
    return normalize(fileURLToPath(uri));
  } catch {
    // a file URI this platform can't express as a path (no drive on Windows) names nothing here
    return undefined;
  }
}

/** A child of a normalized folder path. */
export function childPath(folder: string, name: string): string {
  return folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`;
}

/** The folder a path is in. */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? path : path.slice(0, cut);
}

/** Where a path really is, following links, when it exists. */
function realOrSelf(path: string): string {
  return existsSync(path) ? normalize(realpathSync.native(path)) : path;
}

/** Whether anything, even a link that leads nowhere, is at a path. */
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/**
 * Where a normalized path really is: its deepest existing ancestor (or itself) with links followed, plus the part that
 * doesn't exist yet. `undefined` when that ancestor is a link that leads nowhere, since a write would follow it.
 */
export function reallyAt(path: string): string | undefined {
  const missing: string[] = [];
  let at = path;
  while (!present(at)) {
    const up = parentOf(at);
    if (up === at) { return path; }
    missing.unshift(at.slice(up.length + 1));
    at = up;
  }
  if (!existsSync(at)) { return undefined; }
  const real = normalize(realpathSync.native(at));
  return missing.reduce(childPath, real);
}

/** The guard over a config's roots. Cheap to build, so it is made from whatever config a run carries. */
export class RootGuard implements PathGuard {
  readonly roots: readonly ResolvedRoot[];
  private readonly real: ReadonlyMap<ResolvedRoot, string>;

  constructor(roots: readonly FsRoot[]) {
    this.roots = roots.map((root) => ({ ...root, folder: normalize(root.path) }));
    this.real = new Map(this.roots.map((root) => [root, realOrSelf(root.folder)]));
  }

  root(name: string): ResolvedRoot | undefined {
    return this.roots.find((root) => root.name === name);
  }

  resolve(path: string, options: { write: boolean; cwd?: string | undefined }): Located {
    const first = this.roots[0];
    if (first === undefined) { throw new FsProblem('no-roots', 'No folders are configured yet. An admin sets them in the fs system config.'); }
    const located = this.locate(this.absolute(path.trim(), first, options.cwd));
    if (located === undefined) {
      throw new FsProblem('outside', `${path} is outside the folders this system works in. Use a path under ${this.describe()}.`);
    }
    this.checkLinks(located);
    if (options.write && !located.root.writable) {
      throw new FsProblem('read-only', `${located.path} is in "${located.root.name}", which is read-only.`);
    }
    return located;
  }

  locate(path: string): Located | undefined {
    const target = normalize(path);
    // the deepest root wins when roots nest
    let best: Located | undefined;
    for (const root of this.roots) {
      const rel = inside(root.folder, target);
      if (rel !== undefined && (best === undefined || root.folder.length > best.root.folder.length)) {
        best = { path: target, root, relative: rel };
      }
    }
    return best;
  }

  private absolute(path: string, first: ResolvedRoot, cwd: string | undefined): string {
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) { return normalize(path); }
    if (cwd !== undefined) { return normalize(join(cwd, path)); }
    const [head, ...rest] = path.split(/[\\/]/);
    const named = head === undefined ? undefined : this.root(head);
    return normalize(named === undefined ? join(first.folder, path) : join(named.folder, ...rest));
  }

  /**
   * Refuse a path that is inside a root by name but leads outside it through a link. A path that doesn't exist yet
   * is judged by where its deepest existing folder really is, so a new file can't be made through a link that leads out.
   */
  private checkLinks(located: Located): void {
    const real = reallyAt(located.path);
    if (real === located.path) { return; }
    const ok = real !== undefined
      && this.roots.some((root) => inside(this.real.get(root) ?? root.folder, real) !== undefined || inside(root.folder, real) !== undefined);
    if (!ok) {
      const where = real === undefined ? 'a link that leads nowhere' : real;
      throw new FsProblem('outside', `${located.path} links to ${where}, which is outside the folders this system works in.`);
    }
  }

  private describe(): string {
    return this.roots.map((root) => `"${root.name}" (${root.folder})`).join(', ');
  }
}
