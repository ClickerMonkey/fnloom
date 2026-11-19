/**
 * The resources module's factory: one shared `@aeye/resources` registry, model-made forms through the hub's model
 * roles, the forms service over the store and the content store, the hub's own resources, reading, message content
 * and context. As the hub starts it gives the indexer its reader (the hub's own resources, and every resource cut in
 * its primary form); forms and context changes reach browsers through the bus (`resource.forms`, `context.changed`).
 */
import { ApiError } from '@ayepi/core';
import type { ResourceUri } from '@harness/core';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { IndexReader } from '../index/index.ts';
import { isPicture } from '../index/images.ts';
import type { ModuleFactory } from '../boot/index.ts';
import { StoreContextLibrary } from './context.ts';
import { FormMessageContent } from './content.ts';
import { RegistryConverters } from './converters.ts';
import { LibraryFetcher, WEB, WebSystemFetcher } from './fetch.ts';
import { NO_CONTENT, StoreFormService } from './forms.ts';
import { HubResourceLibrary } from './library.ts';
import { HubFormModels } from './models.ts';
import { LinkRawReader, linkSource } from './raw.ts';
import { FormReader } from './reader.ts';
import { badges, isHubUri } from './rules.ts';

/** Builds the resources module. */
export const resourcesModule: ModuleFactory<'resources'> = ({ hub, hubActor }) => {
  const settings = hub.settings.resourcesEnv;
  const { store, log, clock, bus } = hub;
  const content = hub.api.content;
  const converters = new RegistryConverters({ maxRows: settings.HARNESS_TABLE_ROWS });
  const models = new HubFormModels({ roles: () => hub.models.roles, llm: () => hub.execution.llm, gateway: () => hub.models.gateway });
  const raw = new LinkRawReader({
    source: (uri) => linkSource(hub.link.resources, hub.link.connections, uri), stat: (uri) => hub.link.resources.stat(uri), content, maxChunk: hub.settings.linkEnv.HARNESS_MAX_CHUNK,
  });
  const forms = new StoreFormService({
    store, content, raw, converters, models, log, clock, settings,
    onForms: (record) => { bus.publish('resource.forms', { uri: record.uri, forms: badges(record) }); },
  });
  const reader = new FormReader({ store, content, forms, readChars: settings.HARNESS_READ_CHARS });
  const fetcher = new WebSystemFetcher({
    webConnected: () => hub.link.connections.connection(WEB) !== undefined, runs: () => hub.execution.runs, content, hubActor,
    fallback: new LibraryFetcher({ converters, settings }),
  });
  const library = new HubResourceLibrary({ store, content, forms: () => forms, fetcher, converters, indexer: () => hub.index.indexer, bus, log, clock, settings, hubActor });
  const context = new StoreContextLibrary({
    store, forms: () => forms, reader: () => reader, graph: () => hub.contextor.graph, indexer: () => hub.index.indexer, log, clock, settings, hubActor,
    onContext: (name) => { bus.publish('context.changed', { name }); }, dynamic: () => hub.contextor.dynamic,
  });

  const indexReader: IndexReader = {
    route: (uri: ResourceUri) => {
      if (isHubUri(uri)) { return { system: HUB_SYSTEM, index: 'all' }; }
      const route = hub.link.resources.route(uri);
      return route === undefined ? undefined : { system: route.system, index: route.root.index };
    },
    primary: async (uri, signal) => {
      try {
        return await forms.primary(uri, { actor: hubActor }, { make: settings.HARNESS_DESCRIBE_ON_INDEX, ...(signal === undefined ? {} : { signal }) });
      } catch (error) {
        // a system that sends no content for a resource (a file over its text cap) is still indexed, by name, as before
        if (error instanceof ApiError && error.code === NO_CONTENT && !isHubUri(uri)) { return hub.link.resources.text(uri, signal); }
        throw error;
      }
    },
    sectioned: async (diff) => { await context.sectionsChanged(diff.uri, [...diff.changed, ...diff.removed]); },
    // a picture's raw bytes for the image space, from its snapshot in the content store
    picture: async (uri) => {
      const snapshot = await forms.snapshot(uri, { actor: hubActor });
      if (!isPicture(snapshot.stat)) { return undefined; }
      return { bytes: await content.read(snapshot.raw, 0, snapshot.raw.size), mime: snapshot.raw.mime };
    },
  };
  let stop: (() => void) | undefined;
  return {
    services: { library, forms, reader, content: new FormMessageContent({ forms, reader, content, log }), context },
    hooks: {
      work: {
        up: () => { stop = hub.index.indexer.readWith(indexReader); return Promise.resolve(); },
        pre: () => { stop?.(); return Promise.resolve(); },
      },
    },
  };
};
