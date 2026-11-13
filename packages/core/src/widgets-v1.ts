/**
 * Build 8's widget contracts, for the hub kind `hub/widget`, before the widget pass (build-8-widgets-design.md).
 *
 * `WidgetSpecV1` stays for good: the hub's start-up migration reads old `hub/widget` payloads with it and moves them to
 * the `widgets` system (`upgradeWidgetSpec` in `widgets.ts`). Everything else here is deprecated and goes with its last
 * reader: the hub lane's `packages/hub/src/widgets/` and `widgetsSlice`, the platform lane's sdk `widgets.ts`, the
 * web lane's `components/widgets/`.
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { FnMode } from './manifest.ts';
import { Json, LocalName, QualifiedName, RunId } from './primitives.ts';
import { ResultTable } from './registries.ts';

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

/**
 * A control as a widget's result names it, so the page shows each one with what it is set to: the argument, its label
 * and the only values offered (`custom` lets another be typed). Pinned, hidden and paging arguments are never listed.
 */
export const WidgetShownControlV1 = z.object({
  arg: LocalName,
  label: z.string().min(1),
  choices: z.array(Json).min(1).optional(),
  custom: z.boolean(),
});
export type WidgetShownControlV1 = z.infer<typeof WidgetShownControlV1>;

/** What a widget run returns, and what its renderer draws. */
export const WidgetResultV1 = z.object({
  title: z.string().min(1),
  table: ResultTable,
  /** The source fn and the child run that made the table, so the pager and refresh can ask again. */
  source: z.object({ fn: QualifiedName, run: RunId }),
  /** The spec's visuals that still fit the real columns, in the spec's order; the table visual is always last. */
  visuals: z.array(WidgetVisualV1),
  /** Bindings that no longer fit (a column gone or of another kind), in words; the widget still draws. */
  problems: z.array(z.string()),
  /**
   * How the pager asks for another page, when the widget pages: run the widget again with `arg` set to the page's
   * offset (`table.offset` is this page's, `table.truncated` says whether more follow), `size` rows a page.
   */
  paging: z.object({ arg: LocalName, size: z.number().int().min(1) }).optional(),
  /** The controls it shows, in its source's arg order; absent when it shows none. */
  controls: z.array(WidgetShownControlV1).optional(),
});
export type WidgetResultV1 = z.infer<typeof WidgetResultV1>;

/** An action as a row's menu offers it: derived from the fn, narrowed and labelled by the widget. */
export const WidgetActionOptionV1 = z.object({
  fn: QualifiedName,
  label: z.string().min(1),
  mode: FnMode,
  confirm: z.boolean(),
  bind: z.record(LocalName, z.string().min(1)),
  /** The args left for a form after binding; absent when none are left. */
  form: GinTypeDef.optional(),
  then: ActionThenV1,
});
export type WidgetActionOptionV1 = z.infer<typeof WidgetActionOptionV1>;

/** The actions offered on rows of these types (web `widgetActions`), narrowed by a widget's list when given. */
export const WidgetActionsQueryV1 = z.object({ types: z.array(QualifiedName).min(1).max(20), widget: QualifiedName.optional() });
export type WidgetActionsQueryV1 = z.infer<typeof WidgetActionsQueryV1>;

/** `hub/make_widget`: the source fn, what the person wants, and the widget to change (absent: a new one). */
export const MakeWidgetArgsV1 = z.object({ source: QualifiedName, request: z.string().min(1), widget: QualifiedName.optional() });
export type MakeWidgetArgsV1 = z.infer<typeof MakeWidgetArgsV1>;

/** `hub/widget_check`: a spec and a sample of its source's result; the answer lists every problem, empty when fine. */
export const WidgetCheckV1 = z.object({ spec: WidgetSpecV1, sample: ResultTable });
export type WidgetCheckV1 = z.infer<typeof WidgetCheckV1>;
