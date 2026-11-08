/**
 * The resources area's stores: the one browser (the `/resources` page), a search for each resource picker, and a viewer store for each resource viewer
 * on screen (the browser's panel, the chat's panel, a system renderer's `ResourceViewer`), each following live
 * resource changes while it is shown.
 */
import { getCurrentScope, onScopeDispose } from 'vue';
import type { FileSender } from '../../chat/api.ts';
import type { FetchUrl, ResourceEvents, ResourcesApi } from '../api/resources.ts';
import { ResourceBrowserStore } from './browser.ts';
import { ResourceSearchStore } from './search.ts';
import { ResourceViewerStore, type SystemViewers } from './viewer.ts';

/** What the resources area needs. */
export interface ResourcesDeps {
  readonly api: ResourcesApi;
  readonly events: ResourceEvents;
  readonly sender: FileSender;
  readonly fetch: FetchUrl;
  /** The systems' resource viewers, from the chat's loaded client builds. */
  readonly systems: SystemViewers;
  /** Load the systems' client builds, if they aren't yet, so their viewers are known. */
  readonly prepare: () => Promise<void>;
}

/** The resources area. */
export class ResourcesStore {
  readonly #deps: ResourcesDeps;
  readonly browser: ResourceBrowserStore;

  constructor(deps: ResourcesDeps) {
    this.#deps = deps;
    this.browser = new ResourceBrowserStore({ api: deps.api, events: deps.events, sender: deps.sender });
  }

  /** A resource search for one picker on screen. */
  search(): ResourceSearchStore {
    return new ResourceSearchStore(this.#deps.api);
  }

  /**
   * A viewer store for one viewer on screen, following resource changes until the calling component's scope ends
   * (or until `stop` when there is no scope).
   */
  viewer(): { readonly store: ResourceViewerStore; readonly stop: () => void } {
    const store = new ResourceViewerStore({ api: this.#deps.api, fetch: this.#deps.fetch, systems: this.#deps.systems });
    const stop = this.#deps.events((change) => { store.changed(change); });
    void this.#deps.prepare();
    if (getCurrentScope() !== undefined) { onScopeDispose(stop); }
    return { store, stop };
  }
}
