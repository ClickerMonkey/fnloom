/**
 * The roots served as resources: `file://` URIs for folders and files, folder listings by page, reads with text and
 * links (through `Documents`), and change reports from watching the roots. Each file's `format` lets the hub pick a
 * sectioner (headings for markdown, symbols for code) and a viewer for it. Files a sensitivity rule covers without
 * allowing reads (by name, by being gitignored, or by what their first bytes hold; see `sensitive.ts`) are never
 * listed, read or reported, so the hub never indexes them and a model never sees them without the person approving.
 *
 * What a file is comes from its bytes first, its name second (`detectMime`): a picture named `PHOTO.JPG` (or named
 * `.txt`) is a JPEG, and its stat says so. A file that isn't text (a picture, a pdf, a recording, an office file) is read
 * as its bytes, so the hub converts and shows it the way its kind needs (a pdf's pages, a picture to see); this
 * system's own text of such a file would be empty for a picture or a scan and is never sent instead.
 */
import { join } from 'node:path';
import { detectMime, type Page, type ReadWant, type ResourceChange, type ResourceLink, type ResourceRead, type ResourceRoot, type ResourceStat, type ResourceUri } from '@harness/core';
import type { ProvidedRead, ResourceProvider } from '@harness/sdk';
import type { FileService } from './files.ts';
import type { Documents, Located, PathGuard, WatchFolder } from './index.ts';
import { lastSegment } from '../shared/format.ts';
import { fileUri, inside, normalize, uriPath } from './paths.ts';
import { FsProblem } from './problem.ts';
import type { Sensitivity } from './sensitive.ts';
import { collect, type WalkEntry } from './walk.ts';

/** How resources are served. */
export interface ResourceLimits {
  /** Resources per listed page. */
  readonly page: number;
  /** Largest text returned inline, in characters. */
  readonly textMax: number;
  /** Largest file sent as its bytes (content that isn't text), in bytes. */
  readonly bytesMax: number;
  /** Folder names left out of listings and watches. */
  readonly ignore: readonly string[];
  /** How long changes are gathered before being reported. */
  readonly debounce: number;
}

/** A resource version: changes whenever the content does. */
export function versionOf(modifiedAt: Date, size: number): string {
  return `${modifiedAt.getTime()}-${size}`;
}

/** How many leading bytes of a file are read to tell what it is. */
const MIME_HEAD = 4_096;

/** Formats whose files are read as their bytes, whatever their first bytes say. */
const BYTE_FORMATS: ReadonlySet<string> = new Set(['image', 'pdf', 'audio', 'video', 'docx', 'excel', 'zip']);

/** The format a media type says a file is, when that settles it (a picture, a pdf, a recording, an office file). */
function formatOfMime(mime: string): string | undefined {
  if (mime === 'image/svg+xml') { return undefined; }
  const major = mime.split('/')[0];
  if (major === 'image' || major === 'audio' || major === 'video') { return major; }
  switch (mime) {
    case 'application/pdf': return 'pdf';
    case 'application/zip': return 'zip';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'excel';
    default: return undefined;
  }
}

/** The fs system's resource provider. The guard and secrets come from the current config, so they follow its changes. */
export class FsResources implements ResourceProvider {
  private readonly guard: () => PathGuard;
  private readonly secrets: () => Pick<Sensitivity, 'hidden'>;
  private readonly files: FileService;
  private readonly documents: Documents;
  private readonly limits: ResourceLimits;
  private readonly watchFolder: WatchFolder;

  constructor(deps: { guard: () => PathGuard; secrets: () => Pick<Sensitivity, 'hidden'>; files: FileService; documents: Documents; limits: ResourceLimits; watch: WatchFolder }) {
    this.guard = deps.guard;
    this.secrets = deps.secrets;
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
    const at = await this.located(uri);
    const from = cursor === undefined ? 0 : Number.parseInt(cursor, 10) || 0;
    const children = await this.children(at);
    const slice = children.slice(from, from + this.limits.page);
    // a link is listed as what it leads to, and left out when that is outside the roots
    const stats = await Promise.all(slice.map((child) => (child.type === 'link' ? this.stat(fileUri(child.path)) : this.statPath(child.path, at))));
    const next = from + slice.length;
    return { items: stats.filter((stat) => stat !== undefined), ...(next < children.length ? { cursor: String(next) } : {}) };
  }

  async stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
    const at = await this.within(uri);
    return at === undefined ? undefined : this.statPath(at.path, at);
  }

  async read(uri: ResourceUri, want: ReadWant[]): Promise<ProvidedRead> {
    const at = await this.located(uri);
    const stat = await this.statPath(at.path, at);
    if (stat === undefined) { throw new Error(`${uri} doesn't exist.`); }
    if (stat.type === 'folder') { return this.readFolder(at, stat, want); }
    // content that isn't text goes as its bytes, never as this system's text of it (empty for a picture or a scan)
    if (want.includes('bytes') && this.isBytes(stat)) {
      if ((stat.size ?? 0) > this.limits.bytesMax) { return { stat }; }
      return { stat, bytes: { data: await this.files.raw(at.path), mime: stat.mime ?? 'application/octet-stream' } };
    }
    const tooLarge = (stat.size ?? 0) > this.limits.textMax;
    if (tooLarge || !(want.includes('text') || want.includes('links'))) { return { stat }; }
    // text named like a picture or a pdf is read as the text it is, not parsed as what its name says
    const misnamed = stat.format === 'text' && this.documents.format(at.path) !== 'text';
    const document = misnamed ? { text: new TextDecoder().decode(await this.files.raw(at.path)), links: [] } : await this.documents.read(at.path);
    return { stat, text: { inline: document.text }, links: [...document.links] };
  }

  watch(uris: ResourceUri[], onChange: (changes: ResourceChange[]) => void): () => void {
    const wanted = uris.flatMap((uri) => { const path = uriPath(uri); return path === undefined ? [] : [path]; });
    const guard = this.guard();
    const secrets = this.secrets();
    const folders = new Set(wanted.flatMap((path) => { const at = guard.locate(path); return at === undefined ? [] : [at.root.folder]; }));
    const pending = new Map<string, 'rename' | 'change'>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      const all = [...pending];
      pending.clear();
      const located = all.flatMap(([path]) => { const at = guard.locate(path); return at === undefined ? [] : [at]; });
      const hidden = await secrets.hidden(located, { content: true });
      const batch = all.filter(([path]) => !hidden.has(path));
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

  /**
   * Where a URI is inside the roots, or `undefined` when it is outside them (also through a link), a secret, or not a
   * file URI.
   */
  private async within(uri: ResourceUri): Promise<Located | undefined> {
    const path = uriPath(uri);
    if (path === undefined) { return undefined; }
    let at: Located;
    try {
      at = this.guard().resolve(path, { write: false });
    } catch (error) {
      if (error instanceof FsProblem) { return undefined; }
      throw error;
    }
    return (await this.hiddenOf([at])).has(at.path) ? undefined : at;
  }

  private async located(uri: ResourceUri): Promise<Located> {
    const at = await this.within(uri);
    if (at === undefined) { throw new Error(`${uri} isn't served: it is outside this system's roots, or a secret.`); }
    return at;
  }

  /** Which of these places are secrets: by name, gitignored, or holding a key or token in their first bytes. */
  private hiddenOf(places: readonly Located[]): Promise<Set<string>> {
    return this.secrets().hidden(places, { content: true });
  }

  /** A folder's children, secrets left out. */
  private async children(at: Located): Promise<WalkEntry[]> {
    const all = await collect(at.path, { ignore: this.limits.ignore, depth: 1 });
    const guard = this.guard();
    const hidden = await this.hiddenOf(all.flatMap((child) => { const place = guard.locate(child.path); return place === undefined ? [] : [place]; }));
    return all.filter((child) => !hidden.has(normalize(child.path)));
  }

  private async readFolder(at: Located, stat: ResourceStat, want: ReadWant[]): Promise<ResourceRead> {
    const children = await this.children(at);
    const links: ResourceLink[] = children.map((child) => ({ uri: fileUri(child.path), raw: child.name, kind: 'child', title: child.name }));
    const text = children.map((child) => (child.type === 'folder' ? `${child.name}/` : child.name)).join('\n');
    return { stat, ...(want.includes('links') ? { links } : {}), ...(want.includes('text') ? { text: { inline: text } } : {}) };
  }

  /** Whether a file is read as its bytes: its format says it isn't text, or its first bytes do. */
  private isBytes(stat: ResourceStat): boolean {
    if (stat.format !== undefined && BYTE_FORMATS.has(stat.format)) { return true; }
    const mime = stat.mime ?? '';
    return mime === 'application/octet-stream' || formatOfMime(mime) !== undefined;
  }

  /**
   * A path's stat, following a link (the guard has checked it stays inside the roots). A file's media type is read
   * from its first bytes, then its name; when the bytes say it is a picture, a pdf or a recording, that is its format
   * too, whatever its name says.
   */
  private async statPath(path: string, at: Located): Promise<ResourceStat | undefined> {
    const entry = await this.files.target(path);
    if (entry === undefined) { return undefined; }
    const name = path === at.root.folder ? at.root.name : lastSegment(path);
    const mime = entry.type === 'file' ? detectMime(await this.files.head(path, MIME_HEAD), name) : undefined;
    const named = entry.type === 'file' ? this.documents.format(path) : undefined;
    const settled = mime === undefined ? undefined : formatOfMime(mime);
    // bytes that read as text keep the name's format (a .ts file); bytes that are a picture or a pdf are that
    const format = settled ?? (named !== undefined && BYTE_FORMATS.has(named) && mime !== undefined && mime.startsWith('text/') ? 'text' : named);
    return {
      uri: fileUri(path),
      name,
      type: entry.type === 'folder' ? 'folder' : 'file',
      ...(mime === undefined ? {} : { mime }),
      ...(format === undefined ? {} : { format }),
      ...(entry.type === 'file' ? { size: entry.size } : {}),
      modifiedAt: entry.modifiedAt.getTime(),
      version: versionOf(entry.modifiedAt, entry.size),
    };
  }
}
