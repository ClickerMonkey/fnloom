/**
 * Build 8, the widgets slice: the actions rows of some types offer, narrowed by a widget, as the signed-in person may
 * use them (`widgets/service.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { widgetsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { widgetServiceOf } from '../../widgets/fns.ts';
import type { FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';

/** The widgets plugin. */
export function widgetsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  const widgets = widgetServiceOf(hub);
  return plugin({ name: 'web.widgets', spec: widgetsSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof widgetsSlice> => ({
      widgetActions: ({ data, user }) => widgets.actions(data, user.id),
    }));
}
