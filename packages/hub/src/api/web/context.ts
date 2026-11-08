/**
 * The context slice (resources lane): every context item and its links both ways, memory written and forgotten, and
 * links drawn and removed by people, through `hub.resources.context` (`ContextLibrary`) and the contextor's
 * `ContextGraph`.
 */
import { plugin } from '@ayepi/plugin';
import { contextSlice } from '@harness/core';
import { notBuilt, type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The context plugin. */
export function contextPlugin(auth: ReturnType<typeof authPlugin>) {
  return plugin({ name: 'web.context', spec: contextSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof contextSlice> => ({
      contexts: notBuilt('Listing context'),
      contextItem: notBuilt('Context items'),
      remember: notBuilt('Memory'),
      forget: notBuilt('Forgetting memory'),
      linkContext: notBuilt('Linking context'),
      unlinkContext: notBuilt('Unlinking context'),
    }));
}
