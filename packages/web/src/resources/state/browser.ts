/**
 * The resource browser: the list (or grid) paged for the URL's query with the hub's facets for its grouping, the
 * groups view (each group's first resources, asked for per facet so the hub's grouping is the only one), the folder
 * tree (each folder's subfolders, from the hub's `path` facets, loaded as folders open), the selection, and the
 * actions: import a URL (and fetch an imported page again), upload files, rename and delete hub resources, make context, and make a form (describe,
 * transcribe, convert). Live: `resource` changes refresh the list and groups in the background.
 */
import {
  type ContentRef, type FormKind, type QualifiedName, type ResourceFacet, type ResourcePage, type ResourceQuery, type ResourceRecord, type ResourceUri,
} from '@harness/core';
import { computed, shallowRef } from 'vue';
import type { FileSender } from '../../chat/api.ts';
import { Loaded, Paged, Task, type Outcome } from '../../state/loaded.ts';
import { problemText } from '../../state/problems.ts';
import type { ResourceEvents, ResourcesApi } from '../api/resources.ts';
import { folderQuery, groupQuery, hubQuery, mergeFacets, PAGE_SIZE, type BrowserQuery } from '../logic/browse.ts';
import { webAddress } from '../logic/actions.ts';
import { familyOfStat } from '../logic/formats.ts';

/** What the browser needs. */
export interface BrowserDeps {
  readonly api: Pick<ResourcesApi, 'browse' | 'browseGroup' | 'importResource' | 'rename' | 'remove' | 'contextFrom' | 'convert' | 'upload' | 'uploaded' | 'read' | 'download'>;
  readonly events: ResourceEvents;
  readonly sender: FileSender;
}

/** A file on its way into the hub's resources. */
export interface Upload {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly status: 'uploading' | 'importing' | 'done' | 'failed';
  readonly progress: number;
  readonly problem?: string;
  readonly uri?: ResourceUri;
}

/** What a grid card shows of a resource: an image (its thumbnail form, or the image itself), its first lines, or its glyph. */
export type Peek = { readonly kind: 'image'; readonly url: string } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'none' };

/** How much text a card shows. */
export const PEEK_CHARS = 400;

/** How long changes pause before the list is asked for again (ms). */
export const REFRESH_PAUSE = 500;

/** The resource browser. */
export class ResourceBrowserStore {
  readonly #deps: BrowserDeps;
  readonly query = shallowRef<BrowserQuery>({});
  /** The facets of the list's query for its grouping (from its first page). */
  readonly facets = shallowRef<readonly ResourceFacet[]>([]);
  readonly list: Paged<ResourceRecord, ResourceQuery>;
  /** Each group's first resources in the groups view, by facet value. */
  readonly groups = shallowRef<ReadonlyMap<string, Loaded<ResourcePage>>>(new Map());
  /** Each opened folder's subfolders, by its `under` ('' for the roots). */
  readonly folders = shallowRef<ReadonlyMap<string, Loaded<readonly ResourceFacet[]>>>(new Map());
  readonly selected = shallowRef<ReadonlySet<ResourceUri>>(new Set());
  readonly uploads = shallowRef<readonly Upload[]>([]);
  readonly acting = new Task();
  readonly importing = new Task();
  /** The number of resources selected. */
  readonly selectedCount = computed(() => this.selected.value.size);
  #uploadId = 0;
  #stop: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #aborts = new Map<number, AbortController>();
  readonly #peeks = new Map<string, Loaded<Peek>>();
  /** Bumped on each new query, so a stale group load is ignored. */
  #generation = 0;

  constructor(deps: BrowserDeps) {
    this.#deps = deps;
    this.list = new Paged<ResourceRecord, ResourceQuery>({
      fetch: async (filter, cursor, limit) => {
        const page = await deps.api.browse.call({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) });
        this.facets.value = cursor === undefined ? page.facets : mergeFacets(this.facets.value, page.facets);
        return page;
      },
      key: (record) => record.uri,
      failure: "Couldn't load resources.",
      limit: PAGE_SIZE,
    }, {});
  }

  /** Follow resource changes; returns the function that stops. */
  start(): () => void {
    this.#stop ??= this.#deps.events(() => {
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => { void this.refresh(); }, REFRESH_PAUSE);
    });
    return () => { this.stop(); };
  }

  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
    clearTimeout(this.#timer);
  }

  /** Show the resources for a query from the URL: the list (and the groups, in the groups view). */
  async show(query: BrowserQuery): Promise<void> {
    this.query.value = query;
    this.#generation++;
    this.selected.value = new Set();
    // the list's first page brings the facets the groups are made from
    await this.list.load(hubQuery(query));
    if (query.view === 'groups' && query.in === undefined) { await this.#loadGroups(query); }
  }

  /** Ask for the list and groups again in the background (a resource changed). */
  async refresh(): Promise<void> {
    const query = this.query.value;
    await Promise.all([this.list.refresh(), ...(query.view === 'groups' && query.in === undefined ? [this.#loadGroups(query, true)] : [])]);
  }

  /** Each facet's first resources, once the list's first page has brought the facets. */
  async #loadGroups(query: BrowserQuery, quiet = false): Promise<void> {
    const generation = this.#generation;
    const next = new Map<string, Loaded<ResourcePage>>();
    await Promise.all(this.facets.value.map(async (facet) => {
      const loaded = (quiet ? this.groups.value.get(facet.value) : undefined) ?? new Loaded<ResourcePage>();
      next.set(facet.value, loaded);
      await loaded.load(() => this.#deps.api.browseGroup.call(groupQuery(query, facet)), "Couldn't load this group.", quiet);
    }));
    if (generation === this.#generation) { this.groups.value = next; }
  }

  /** Load a folder's subfolders for the tree (again, with `again`). */
  async openFolder(under: string, again = false): Promise<void> {
    const known = this.folders.value.get(under);
    if (known !== undefined && !again) { return; }
    const loaded = known ?? new Loaded<readonly ResourceFacet[]>();
    if (known === undefined) { this.folders.value = new Map([...this.folders.value, [under, loaded]]); }
    await loaded.load(async () => (await this.#deps.api.browseGroup.call(folderQuery(this.query.value, under))).facets, "Couldn't load the folders.");
  }

  /**
   * What a grid card shows, loaded the first time a card asks: the thumbnail form, else an image itself, else the first
   * lines of a text or code resource, else nothing (the card draws its glyph). Kept per URI and version.
   */
  peek(record: ResourceRecord): Loaded<Peek> {
    const key = `${record.uri}@${record.stat.version}`;
    const known = this.#peeks.get(key);
    if (known !== undefined) { return known; }
    const loaded = new Loaded<Peek>();
    this.#peeks.set(key, loaded);
    void loaded.load(() => this.#peek(record), '', true);
    return loaded;
  }

  async #peek(record: ResourceRecord): Promise<Peek> {
    const family = familyOfStat(record.stat);
    if (record.forms?.includes('thumbnail') === true) { return { kind: 'image', url: (await this.#deps.api.download.call({ uri: record.uri, form: 'thumbnail' })).url }; }
    if (family === 'image') { return { kind: 'image', url: (await this.#deps.api.download.call({ uri: record.uri })).url }; }
    if (family === 'code' || family === 'document' || family === 'data' || family === 'table' || family === 'web') {
      const read = await this.#deps.api.read.call({ uri: record.uri, maxChars: PEEK_CHARS });
      return read.text.trim() === '' ? { kind: 'none' } : { kind: 'text', text: read.text };
    }
    return { kind: 'none' };
  }

  // ─── Selection ──────────────────────────────────────────────────────────

  toggle(uri: ResourceUri): void {
    const next = new Set(this.selected.value);
    if (next.has(uri)) { next.delete(uri); } else { next.add(uri); }
    this.selected.value = next;
  }

  /** Select every loaded resource, or none when they all are. */
  toggleAll(): void {
    const all = this.list.items.value.map((r) => r.uri);
    this.selected.value = all.every((uri) => this.selected.value.has(uri)) ? new Set() : new Set(all);
  }

  clearSelection(): void {
    this.selected.value = new Set();
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  /** Import a web page (or any URL) as a hub resource. */
  async importUrl(url: string): Promise<Outcome<ResourceRecord>> {
    const done = await this.importing.run(() => this.#deps.api.importResource.call({ url }), "Couldn't import that address.");
    if (done.ok) { void this.list.refresh(); }
    return done;
  }

  /** Fetch pages imported from the web again (each keeps its name; the hub keeps it at the same address as a new version). Answers how many were fetched. */
  async refetch(records: readonly Pick<ResourceRecord, 'source' | 'stat'>[]): Promise<number | undefined> {
    const pages = records.flatMap((record) => { const url = webAddress(record); return url === undefined ? [] : [{ url, name: record.stat.name }]; });
    const done = await this.acting.run(() => Promise.all(pages.map((page) => this.#deps.api.importResource.call(page))), "Couldn't fetch that again.");
    if (!done.ok) { return undefined; }
    void this.list.refresh();
    return done.value.length;
  }

  /** Upload files and import each as a hub resource; each shows its progress until it is done or failed. */
  async upload(files: readonly File[]): Promise<void> {
    await Promise.all(files.map((file) => this.#uploadOne(file)));
    void this.list.refresh();
  }

  async #uploadOne(file: File): Promise<void> {
    const id = ++this.#uploadId;
    const abort = new AbortController();
    this.#aborts.set(id, abort);
    this.#setUpload({ id, name: file.name, size: file.size, status: 'uploading', progress: 0 });
    try {
      const mime = file.type === '' ? 'application/octet-stream' : file.type;
      const { url, upload } = await this.#deps.api.upload.call({ name: file.name, mime, size: file.size });
      await this.#deps.sender.put(url, file, (progress) => { this.#patchUpload(id, { progress }); }, abort.signal);
      this.#patchUpload(id, { status: 'importing', progress: 1 });
      const content: ContentRef = await this.#deps.api.uploaded.call({ upload });
      const record = await this.#deps.api.importResource.call({ content, name: file.name });
      this.#patchUpload(id, { status: 'done', uri: record.uri });
    } catch (error) {
      this.#patchUpload(id, { status: 'failed', problem: problemText(error, `Couldn't upload ${file.name}.`) });
    } finally {
      this.#aborts.delete(id);
    }
  }

  /** Stop an upload on its way, or forget a finished one. */
  dismissUpload(id: number): void {
    this.#aborts.get(id)?.abort();
    this.uploads.value = this.uploads.value.filter((u) => u.id !== id);
  }

  #setUpload(upload: Upload): void {
    this.uploads.value = [...this.uploads.value, upload];
  }

  #patchUpload(id: number, patch: Partial<Omit<Upload, 'id'>>): void {
    this.uploads.value = this.uploads.value.map((u) => (u.id === id ? { ...u, ...patch } : u));
  }

  /** Rename a hub resource. */
  async rename(uri: ResourceUri, name: string): Promise<boolean> {
    const done = await this.acting.run(() => this.#deps.api.rename.call({ uri, name }), "Couldn't rename it.");
    if (done.ok) { void this.list.refresh(); }
    return done.ok;
  }

  /** Delete hub resources; answers how many were deleted and how many references the rest still had. */
  async remove(uris: readonly ResourceUri[]): Promise<{ readonly deleted: number; readonly kept: number } | undefined> {
    const done = await this.acting.run(async () => {
      const results = await Promise.all(uris.map((uri) => this.#deps.api.remove.call({ uri })));
      return { deleted: results.filter((r) => r.deleted).length, kept: results.filter((r) => !r.deleted).length };
    }, "Couldn't delete that.");
    if (!done.ok) { return undefined; }
    this.selected.value = new Set([...this.selected.value].filter((uri) => !uris.includes(uri)));
    await this.list.load();
    return done.value;
  }

  /** Make context from resources; answers the items made or updated, in order. */
  async makeContext(uris: readonly ResourceUri[]): Promise<readonly QualifiedName[] | undefined> {
    const done = await this.acting.run(async () => {
      const results = await Promise.all(uris.map((uri) => this.#deps.api.contextFrom.call({ uri, copy: 'live' })));
      return results.flatMap((r) => [...r.created, ...r.updated]);
    }, "Couldn't make context from that.");
    return done.ok ? done.value : undefined;
  }

  /** A presigned download of a resource's raw content. */
  async downloadUrl(uri: ResourceUri): Promise<string | undefined> {
    const done = await this.acting.run(() => this.#deps.api.download.call({ uri }), "Couldn't start the download.");
    return done.ok ? done.value.url : undefined;
  }

  /** Make a form of resources now (describe, transcribe, convert). */
  async make(uris: readonly ResourceUri[], kind: FormKind): Promise<boolean> {
    const done = await this.acting.run(() => Promise.all(uris.map((uri) => this.#deps.api.convert.call({ uri, kind }))), "Couldn't make that.");
    if (done.ok) { void this.list.refresh(); }
    return done.ok;
  }
}
