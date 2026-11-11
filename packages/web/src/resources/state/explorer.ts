/**
 * The file explorer (`/explore/:system/:instance/…`): one system instance's roots, each folder's entries fetched page
 * by page the first time it is shown (the tree and the list share them), and the opened file's text. Every read goes
 * live to the system as the person, through the hub, and nothing is saved as a resource.
 */
import { ResourceUri, type InstanceName, type ResourceRead, type ResourceRoot, type ResourceStat, type SystemName } from '@harness/core';
import { shallowRef } from 'vue';
import { Loaded, Paged } from '../../state/loaded.ts';
import type { ResourcesApi } from '../api/resources.ts';

/** How many entries a folder shows before "Show more". */
export const EXPLORE_PAGE = 200;

/** The explorer's callers. */
export type ExplorerApi = Pick<ResourcesApi, 'exploreRoots' | 'exploreList' | 'exploreRead'>;

/** One system instance's files, live. */
export class ExplorerStore {
  readonly #api: ExplorerApi;
  readonly #folders = new Map<ResourceUri, Paged<ResourceStat, ResourceUri>>();
  /** Which instance the roots are of (`system/instance`). */
  readonly at = shallowRef('');
  readonly roots = new Loaded<readonly ResourceRoot[]>();
  /** The opened file's read (its stat and text). */
  readonly file = new Loaded<ResourceRead>();

  constructor(api: ExplorerApi) {
    this.#api = api;
  }

  /** Show an instance's roots; another instance starts afresh. */
  async open(system: SystemName, instance: InstanceName): Promise<void> {
    const at = `${system}/${instance}`;
    if (this.at.value === at && this.roots.value.value !== undefined) { return; }
    this.at.value = at;
    this.#folders.clear();
    this.file.reset();
    await this.roots.load(() => this.#api.exploreRoots.call({ system, instance }), `Couldn't list ${at}'s folders.`);
  }

  /** A folder's entries, fetched the first time it is asked for. */
  folder(uri: ResourceUri): Paged<ResourceStat, ResourceUri> {
    const known = this.#folders.get(uri);
    if (known !== undefined) { return known; }
    const made = new Paged<ResourceStat, ResourceUri>({
      fetch: (folder, cursor) => this.#api.exploreList.call({ uri: folder, ...(cursor === undefined ? {} : { cursor }) }),
      key: (entry) => entry.uri,
      failure: "Couldn't list this folder.",
      limit: EXPLORE_PAGE,
    }, uri);
    this.#folders.set(uri, made);
    void made.load();
    return made;
  }

  /** A folder's entries if they were asked for, without asking (for drawing). */
  peek(uri: string): Paged<ResourceStat, ResourceUri> | undefined {
    const parsed = ResourceUri.safeParse(uri);
    return parsed.success ? this.#folders.get(parsed.data) : undefined;
  }

  /** Read a file's text, or forget the opened file. */
  async read(uri: ResourceUri | undefined): Promise<void> {
    if (uri === undefined) { this.file.reset(); return; }
    if (this.file.value.value?.stat.uri === uri) { return; }
    await this.file.load(() => this.#api.exploreRead.call({ uri, want: ['text'] }), "Couldn't read this file.");
  }

  /** Fetch a folder's entries again (after a change on disk). */
  refresh(uri: ResourceUri): void {
    void this.#folders.get(uri)?.load();
  }
}
