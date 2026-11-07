/**
 * The roots served as resources: `file://` URIs for folders and files, folder listings by page, reads with text and
 * links (through `Documents`), and change reports from watching the roots. Each file's `format` lets the hub pick a
 * sectioner (headings for markdown, symbols for code) and a viewer for it.
 */
import { join } from 'node:path';
import type { Page, ReadWant, ResourceChange, ResourceLink, ResourceRead, ResourceRoot, ResourceStat, ResourceUri } from '@harness/core';
import type { ResourceProvider } from '@harness/sdk';
import type { FileService } from './files.ts';
import type { Documents, Located, PathGuard, WatchFolder } from './index.ts';
import { lastSegment } from '../shared/format.ts';
import { fileUri, inside, normalize, uriPath } from './paths.ts';
import { FsProblem } from './problem.ts';
import { collect } from './walk.ts';

/** How resources are served. */
export interface ResourceLimits {
  /** Resources per listed page. */
  readonly page: number;
  /** Largest text returned inline, in characters. */
  readonly textMax: number;
  /** Folder names left out of listings and watches. */
  readonly ignore: readonly string[];
  /** How long changes are gathered before being reported. */
  readonly debounce: number;
}

/** A resource version: changes whenever the content does. */
export function versionOf(modifiedAt: Date, size: number): string {
  return `${modifiedAt.getTime()}-${size}`;
}

/** The fs system's resource provider. The guard comes from the current config, so it follows config changes. */
export class FsResources implements ResourceProvider {
  private readonly guard: () => PathGuard;
  private readonly files: FileService;
  private readonly documents: Documents;
  private readonly limits: ResourceLimits;
  private readonly watchFolder: WatchFolder;

  constructor(deps: { guard: () => PathGuard; files: FileService; documents: Documents; limits: ResourceLimits; watch: WatchFolder }) {
    this.guard = deps.guard;
    this.files = deps.files;
    this.documents = deps.documents;
    this.limits = deps.limits;
    this.watchFolder = deps.watch;
  }

  roots(): Promise<ResourceRoot[]> {
    return Promise.resolve(this.guard().roots.map((root) => ({
      uri: fileUri(root.folder),
      name: root.name,
      description: `Files under ${root.folder}${root.writable ? '' : ' (read-only)'}.`,
      index: root.index,
      ignore: this.limits.ignore.map((name) => `**/${name}/**`),
      watch: true,
    })));
  }

  async list(uri: ResourceUri, cursor?: string): Promise<Page<ResourceStat>> {
    const at = this.located(uri);
    const from = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
    const children = await collect(at.path, { ignore: this.limits.ignore, depth: 1 });
    const slice = children.slice(from, from + this.limits.page);
    // a link is listed as what it leads to, and left out when that is outside the roots
    const stats = await Promise.all(slice.map((child) => (child.type === 'link' ? this.stat(fileUri(child.path)) : this.statPath(child.path, at))));
    const next = from + slice.length;
    return { items: stats.filter((stat) => stat !== undefined), ...(next < children.length ? { cursor: String(next) } : {}) };
  }

  async stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
    const at = this.within(uri);
    return at === undefined ? undefined : this.statPath(at.path, at);
  }

  async read(uri: ResourceUri, want: ReadWant[]): Promise<ResourceRead> {
    const at = this.located(uri);
    const stat = await this.statPath(at.path, at);
    if (stat === undefined) { throw new Error(`${uri} doesn't exist.`); }
    if (stat.type === 'folder') { return this.readFolder(at, stat, want); }
    const tooLarge = (stat.size ?? 0) > this.limits.textMax;
    if (tooLarge || !(want.includes('text') || want.includes('links'))) { return { stat }; }
    const document = await this.documents.read(at.path);
    return { stat, text: { inline: document.text }, links: [...document.links] };
  }

  watch(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void {
    const wanted = uris.flatMap((uri) => { const path = uriPath(uri); return path === undefined ? [] : [path]; });
    const guard = this.guard();
    const folders = new Set(wanted.flatMap((path) => { const at = guard.locate(path); return at === undefined ? [] : [at.root.folder]; }));
    const pending = new Map<string, 'rename' | 'change'>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      const batch = [...pending];
      pending.clear();
      const changes = await Promise.all(batch.map(async ([path, event]): Promise<ResourceChange> => {
        const entry = await this.files.entry(path);
        if (entry === undefined) { return { uri: fileUri(path), change: 'removed' }; }
        return { uri: fileUri(path), change: event === 'rename' ? 'added' : 'changed', version: versionOf(entry.modifiedAt, entry.size) };
      }));
      if (changes.length > 0) { onChange(changes); }
    };
    const stops = [...folders].map((folder) => this.watchFolder(folder, (event, file) => {
      const path = normalize(join(folder, file));
      const rel = inside(folder, path);
      if (rel === undefined || rel.split('/').some((part) => this.limits.ignore.includes(part))) { return; }
      if (!wanted.some((root) => inside(root, path) !== undefined)) { return; }
      pending.set(path, pending.get(path) === 'rename' ? 'rename' : event);
      timer ??= setTimeout(() => { void flush(); }, this.limits.debounce);
    }));
    return () => {
      if (timer !== undefined) { clearTimeout(timer); }
      for (const stop of stops) { stop(); }
    };
  }

  /** Where a URI is inside the roots, or `undefined` when it is outside them (also through a link) or not a file URI. */
  private within(uri: ResourceUri): Located | undefined {
    const path = uriPath(uri);
    if (path === undefined) { return undefined; }
    try {
      return this.guard().resolve(path, { write: false });
    } catch (error) {
      if (error instanceof FsProblem) { return undefined; }
      throw error;
    }
  }

  private located(uri: ResourceUri): Located {
    const at = this.within(uri);
    if (at === undefined) { throw new Error(`${uri} isn't under any of this system's roots.`); }
    return at;
  }

  private async readFolder(at: Located, stat: ResourceStat, want: ReadWant[]): Promise<ResourceRead> {
    const children = await collect(at.path, { ignore: this.limits.ignore, depth: 1 });
    const links: ResourceLink[] = children.map((child) => ({ uri: fileUri(child.path), raw: child.name, kind: 'child', title: child.name }));
    const text = children.map((child) => (child.type === 'folder' ? `${child.name}/` : child.name)).join('\n');
    return { stat, ...(want.includes('links') ? { links } : {}), ...(want.includes('text') ? { text: { inline: text } } : {}) };
  }

  /** A path's stat, following a link (the guard has checked it stays inside the roots). */
  private async statPath(path: string, at: Located): Promise<ResourceStat | undefined> {
    const entry = await this.files.target(path);
    if (entry === undefined) { return undefined; }
    const name = path === at.root.folder ? at.root.name : lastSegment(path);
    const format = entry.type === 'file' ? this.documents.format(path) : undefined;
    return {
      uri: fileUri(path),
      name,
      type: entry.type === 'folder' ? 'folder' : 'file',
      ...(format === undefined ? {} : { format }),
      ...(entry.type === 'file' ? { size: entry.size } : {}),
      modifiedAt: entry.modifiedAt.getTime(),
      version: versionOf(entry.modifiedAt, entry.size),
    };
  }
}
