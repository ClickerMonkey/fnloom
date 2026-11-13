/**
 * Build 8's saved widget payload, from the hub kind `hub/widget` before the widget pass (build-8-widgets-design.md).
 *
 * It stays for good: the hub's start-up migration reads old `hub/widget` payloads with `WidgetSpecV1` and moves them
 * to the `widgets` system (`upgradeWidgetSpec` in `widgets.ts`). Build 8's other widget contracts are gone.
 */
import { z } from 'zod';
import { Json, LocalName, QualifiedName } from './primitives.ts';

/** Build 8's hub widget kind, whose fns the migration moves to `WIDGET_KIND`. */
export const WIDGET_KIND_V1 = 'hub/widget';

/** How the widget shows one argument of its source fn. */
export const WidgetControlV1 = z.object({
  arg: LocalName,
  /** The label instead of the argument's name. */
  label: z.string().min(1).optional(),
  /** The only values offered, in order. */
  choices: z.array(Json).min(1).optional(),
  /** Whether a value outside `choices` may be typed. */
  custom: z.boolean().optional(),
  /** A fixed value: the argument leaves the widget's args and its control is not shown. */
  pinned: Json.optional(),
  /** Keep the argument (it takes its default) but show no control. */
  hidden: z.boolean().optional(),
});
export type WidgetControlV1 = z.infer<typeof WidgetControlV1>;

/** The source's paging arguments, which the widget's pager drives instead of showing them as controls. */
export const WidgetPagingV1 = z.object({ offset: LocalName.optional(), limit: LocalName.optional(), size: z.number().int().min(1).max(500) });
export type WidgetPagingV1 = z.infer<typeof WidgetPagingV1>;

/** One visual the widget offers, with which columns bind to each of its channels. */
export const WidgetVisualV1 = z.object({
  /** The visual's name in `HUB_VISUALS`. */
  visual: LocalName,
  /** The switcher's label instead of the visual's. */
  label: z.string().min(1).optional(),
  /** Channel name → column names; a channel left out is bound by the visual's own logic. */
  bind: z.record(LocalName, z.array(z.string().min(1)).min(1)),
});
export type WidgetVisualV1 = z.infer<typeof WidgetVisualV1>;

/** What follows an action: run the widget again, show the action's result in its own view, or nothing. */
export const ActionThenV1 = z.enum(['refresh', 'show', 'none']);
export type ActionThenV1 = z.infer<typeof ActionThenV1>;

/** One action a widget keeps, relabels or confirms: a method of the row's type, or any fn with args bound to columns. */
export const WidgetActionV1 = z.object({
  /** The fn: a type method (`fs/Entry.reveal`) or any fn. */
  fn: QualifiedName,
  label: z.string().min(1).optional(),
  /** `true` asks before running even a read. Writes and deletes always ask. */
  confirm: z.literal(true).optional(),
  /** Argument → the column whose value it takes from the row (`self` for a method is bound by `ref`). */
  bind: z.record(LocalName, z.string().min(1)),
  then: ActionThenV1,
});
export type WidgetActionV1 = z.infer<typeof WidgetActionV1>;

/** A saved widget: the payload of a `hub/widget` fn. */
export const WidgetSpecV1 = z.object({
  title: z.string().min(1),
  /** The fn whose result it draws; it must return a `ResultTable`. */
  source: QualifiedName,
  /** The visuals offered, the first shown first. */
  visuals: z.array(WidgetVisualV1).min(1),
  controls: z.array(WidgetControlV1),
  paging: WidgetPagingV1.optional(),
  /** The actions offered on each row; absent offers every derived one, `[]` none. */
  actions: z.array(WidgetActionV1).optional(),
});
export type WidgetSpecV1 = z.infer<typeof WidgetSpecV1>;
