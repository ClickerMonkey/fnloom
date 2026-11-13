/**
 * The widgets system's tunables, an `@ayepi/env` slice.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const widgetsEnv = env({
  ...systemFields(),
  /** The rows one widget run reads into the buffered pager (the source's limit); a full window means more may follow. */
  WIDGETS_WINDOW: z.number().int().min(1).max(5000).default(200),
  /** The rows of the source's sample the authoring agent reads. */
  WIDGETS_SAMPLE_ROWS: z.number().int().min(1).max(50).default(8),
  /** How many names `save_widget` and the agent's proposal try (`sales_by_month`, `sales_by_month_2`, …). */
  WIDGETS_NAME_TRIES: z.number().int().min(1).max(50).default(10),
  /** The shortest time between a live widget's runs while it is shown, in ms (`WidgetResult.live`). */
  HARNESS_WIDGET_LIVE_FLOOR: z.number().int().min(1000).default(5000),
}).add(systemState('widgets'));

/** The widgets system's settings, resolved. */
export type WidgetsSettings = ReturnType<typeof widgetsEnv.parse>;
