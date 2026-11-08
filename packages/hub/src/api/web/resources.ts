/**
 * The resources slice (resources lane): browsing with groups and facets, reading any form, making forms, importing
 * URLs and uploads, renaming and deleting hub resources, and making context from a resource. Each handler runs the
 * same operation as the hub fn of the same purpose, through `hub.resources` (`resources/index.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { resourcesSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The resources plugin. */
export function resourcesPlugin(auth: ReturnType<typeof authPlugin>) {
  return plugin({ name: 'web.resources', spec: resourcesSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof resourcesSlice> => ({
      browseResources: notBuilt('Browsing resources'),
      resourceForms: notBuilt('Resource forms'),
      readResource: notBuilt('Reading resources'),
      convertResource: notBuilt('Converting resources'),
      downloadResource: notBuilt('Downloading resources'),
      importResource: notBuilt('Importing resources'),
      renameResource: notBuilt('Renaming resources'),
      deleteResource: notBuilt('Deleting resources'),
      contextFromResource: notBuilt('Context from resources'),
    }));
}
