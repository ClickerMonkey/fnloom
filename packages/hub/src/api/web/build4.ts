/**
 * Build 4's web slices: visibility (`accessSlice`), per-person connections (`connectionsSlice`) and pickers
 * (`pickerSlice`).
 */
import { plugin } from '@ayepi/plugin';
import { pickerSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import { pick } from './pickers.ts';
import type { systemsPlugin } from './systems.ts';
import { accessPlugin, connectionsPlugin } from './visibility.ts';

/** The build 4 plugins. Require the systems plugin, which binds `hubAuth`. */
export function build4Plugins(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return [
    accessPlugin(hub, systems),
    connectionsPlugin(hub, systems),
    plugin({ name: 'web.picker', spec: pickerSlice, requires: [systems] })
      .handlers((): FullHandlers<typeof pickerSlice> => {
        const deps = { access: hub.access, catalog: hub.catalog, store: hub.store, llm: hub.execution.llm, settings: hub.settings.queryEnv };
        return { pick: ({ data, user }) => pick(deps, user.id, data) };
      }),
  ] as const;
}
