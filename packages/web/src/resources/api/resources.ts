/**
 * The resource browser's and viewer's callers, made once from the one hub client: browsing with facets, a
 * resource's forms, reading a form's text, making a form, presigned downloads, importing a URL or an upload,
 * renaming and deleting hub resources, and making context from a resource; plus the chat's `resource` read, which
 * the viewer falls back to for a resource the hub's resource library doesn't hold. Stores receive only the callers
 * they use (`Pick<ResourcesApi, …>`), so tests hand them fakes. Live changes come through `ResourceEvents`.
 */
import type { FormKind, ResourceUri } from '@harness/core';
import type { Hub } from '../../api/client.ts';
import type { UserEvents } from '../../api/notifications.ts';

/** Make the resource callers. */
export function resourcesApi(hub: Hub) {
  return {
    /** The list's pages; a newer first page (a filter changed) supersedes one still on its way. */
    browse: hub.caller('browseResources', { lastOnly: true }),
    /** One group's first resources, or one folder's subfolders: many at once, none superseding another. */
    browseGroup: hub.caller('browseResources'),
    forms: hub.caller('resourceForms', { dedupe: true }),
    read: hub.caller('readResource', { dedupe: true }),
    convert: hub.caller('convertResource'),
    download: hub.caller('downloadResource', { dedupe: true }),
    importResource: hub.caller('importResource'),
    rename: hub.caller('renameResource'),
    remove: hub.caller('deleteResource'),
    contextFrom: hub.caller('contextFromResource'),
    upload: hub.caller('upload'),
    uploaded: hub.caller('uploaded'),
    /** A system's own read of a resource (stat, links and text), for resources the library doesn't hold. */
    systemRead: hub.caller('resource', { dedupe: true }),
  };
}

/** The resource callers. */
export type ResourcesApi = ReturnType<typeof resourcesApi>;

/** A resource changed or a form of it was made. */
export interface ResourceChange {
  readonly uri: ResourceUri;
  readonly forms: readonly FormKind[];
}

/** Listen to resource changes; returns the function that stops listening. */
export type ResourceEvents = (listener: (change: ResourceChange) => void) => () => void;

/** Resource changes from the user's live events (the hub's `user` channel). */
export function resourceEvents(events: UserEvents): ResourceEvents {
  return (listener) => events((event) => { if (event.type === 'resource') { listener({ uri: event.uri, forms: event.forms }); } });
}

/** Fetch bytes or a converted version from a presigned URL (the browser's `fetch`, unless a test passes one). */
export type FetchUrl = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;
