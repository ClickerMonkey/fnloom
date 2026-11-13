/**
 * The widget fns on the hub (build 8): the `hub/widget` kind's runs, and the tools `hub/make_widget` works with
 * (`hub/widget_source`, `hub/widget_visuals`, `hub/widget_check`, `hub/widget_save`). Args arrive checked against the
 * contract's gin types; parsing them adds the brands.
 */
import { Json, WIDGET_KIND, WidgetCheck } from '@harness/core';
import { hub, WidgetSaveArgs, WidgetSourceArgs } from '@harness/sdk';
import type { HubServices } from '../boot/index.ts';
import type { HubFns } from '../execution/executors.ts';
import { WidgetService } from './service.ts';

/** The widget service over the hub's services, each looked up when it is needed. */
export function widgetServiceOf(services: HubServices): WidgetService {
  return new WidgetService({
    catalog: () => services.catalog, runs: () => services.execution.runs, facts: () => services.fns.facts, store: () => services.store,
    access: (actor) => services.access.scope(actor), sharing: () => services.access,
  });
}

/** Register the widget kind and the widget tools. */
export function registerWidgetFns(fns: HubFns, widgets: () => WidgetService): void {
  const { fns: refs } = hub;
  fns.registerKind(WIDGET_KIND, async (fn, args, ctx) => Json.parse(await widgets().run(fn, args, ctx.request.run)));
  fns.register(refs.widget_source, async (args, ctx) => {
    const { source, args: sample } = WidgetSourceArgs.parse(args);
    return widgets().source(source, sample, ctx.request.run);
  });
  fns.register(refs.widget_visuals, async (args, ctx) => {
    const { source, args: sample } = WidgetSourceArgs.parse(args);
    return widgets().fits(source, sample, ctx.request.run);
  });
  fns.register(refs.widget_check, (args) => widgets().check(WidgetCheck.parse(args)));
  fns.register(refs.widget_save, (args, ctx) => widgets().save(WidgetSaveArgs.parse(args), ctx.request.run));
}
