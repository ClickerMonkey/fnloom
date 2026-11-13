/**
 * Registries: a system declares a registry of components, and any system (itself included) contributes
 * entries to it from its client bundle. The first registry is the database system's query visuals: each visual's
 * client code says whether a result table fits it and how well (`VisualFit`); the result view shows the best fit and
 * lets the person switch between every visual that fits. The table is always there, with the lowest score.
 *
 * The result table itself (`ResultTable`) lives here because a visual from any system draws it, and because an
 * approval preview shows the rows a write would touch.
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { Json, LocalName, QualifiedName, SystemName } from './primitives.ts';

// ─── Registries and contributions (manifest) ─────────────────────────────────

/** The kinds of value a result column holds, for formatting and for visuals' match logic. */
export const COLUMN_KINDS = ['text', 'integer', 'number', 'boolean', 'date', 'datetime', 'time', 'uuid', 'json', 'binary'] as const;
export const ColumnKind = z.enum(COLUMN_KINDS);
export type ColumnKind = z.infer<typeof ColumnKind>;

/**
 * What a column is for (`ResultColumn.role`), when its source knows (the database knows a GROUP BY key from an
 * aggregate): a `group` key rows are grouped by, a `measure` (a count, a sum), or an `attribute` of a row. Absent, the
 * hub derives it from the column's kind and values (`columnFacts` in `visuals.ts`).
 */
export const COLUMN_ROLES = ['group', 'measure', 'attribute'] as const;
export const ColumnRole = z.enum(COLUMN_ROLES);
export type ColumnRole = z.infer<typeof ColumnRole>;

/**
 * One input of a visual: a named slot columns bind to (`category`, `value`, `x`, `start`), named after the ECharts
 * encode dimension where there is one; the column kinds it takes; whether it must be bound; whether it takes several
 * columns (a line chart's series; at least `min` of them); and the role it wants (a category a `group` key, a value a
 * `measure`). A column shown only in a tooltip is not bound and does not count towards coverage.
 */
export const VisualChannel = z.object({
  name: LocalName,
  label: z.string().min(1),
  accepts: z.array(ColumnKind).min(1),
  required: z.boolean(),
  many: z.boolean(),
  /** The fewest columns a `many` channel needs (parallel axes need 3). */
  min: z.number().int().min(1).optional(),
  role: z.enum(['group', 'measure']).optional(),
});
export type VisualChannel = z.infer<typeof VisualChannel>;

/**
 * The closed list of conditions a visual's data must meet beyond its channels (widget pass), judged over the column
 * facts (`columnFacts`), so the hub, an agent and the browser judge a fit alike without running a system's code:
 *
 * - `distinct`: the column bound to `channel` has at most `max` distinct values (a pie's slices).
 * - `non-negative`: every value bound to `channel` is 0 or more (slices, funnels).
 * - `bounded`: the value bound to `channel` has a known range (its type's min and max, or a bound `max` channel).
 * - `distinct-columns`: the channels bind different columns (a sankey's source and target).
 * - `links`: the values bound to `to` are values bound to `from` (a parent column naming rows: a tree).
 */
export const VisualRule = z.discriminatedUnion('rule', [
  z.object({ rule: z.literal('distinct'), channel: LocalName, max: z.number().int().min(1) }),
  z.object({ rule: z.literal('non-negative'), channel: LocalName }),
  z.object({ rule: z.literal('bounded'), channel: LocalName }),
  z.object({ rule: z.literal('distinct-columns'), channels: z.array(LocalName).min(2) }),
  z.object({ rule: z.literal('links'), from: LocalName, to: LocalName }),
]);
export type VisualRule = z.infer<typeof VisualRule>;

/**
 * How a visual stays honest when a result is bigger than it draws (product's size strategy): `window` pages through
 * it, `top-n` draws the first categories in the result's own order and says "Showing 50 of 137", `partition` folds the
 * rest into an "Other" slice (browser maths, only over a whole result), `aggregate` needs an aggregated result.
 * Absent: past its rules the visual is not offered.
 */
export const VISUAL_SIZE_STRATEGIES = ['window', 'top-n', 'partition', 'aggregate'] as const;
export const VisualSizeStrategy = z.enum(VISUAL_SIZE_STRATEGIES);
export type VisualSizeStrategy = z.infer<typeof VisualSizeStrategy>;

/**
 * One style of a visual family, which the style picker offers (bar, stacked, 100%, horizontal): the same bindings,
 * drawn another way. `whole` marks a style that states shares of the whole (100% bars), offered only for a whole
 * result; `needs` names channels this style must have bound (a bubble's size).
 */
export const VisualStyle = z.object({
  name: LocalName,
  label: z.string().min(1),
  whole: z.literal(true).optional(),
  needs: z.array(LocalName).optional(),
});
export type VisualStyle = z.infer<typeof VisualStyle>;

/**
 * An argument pair a visual drives itself: a calendar's month or a zoomed time axis sets the widget's range args
 * (`WidgetSpec.range`) from what is shown on `channel`. Brushing a range filter comes later.
 */
export const VisualClaim = z.object({ claim: z.literal('range'), channel: LocalName });
export type VisualClaim = z.infer<typeof VisualClaim>;

/** The priority bands of product's order (coverage first, then priority, then registry order); values in `visuals.ts`. */
export const PRIORITY_BANDS = ['floor', 'structural', 'encoded', 'time-encoded'] as const;
export const PriorityBand = z.enum(PRIORITY_BANDS);
export type PriorityBand = z.infer<typeof PriorityBand>;

/** The named terms a visual's priority adds when the data shows them; values and reasons in `visuals.ts`. */
export const PRIORITY_TERMS = ['temporal-key', 'low-cardinality', 'enum-key', 'high-null', 'many-categories'] as const;
export const PriorityTerm = z.enum(PRIORITY_TERMS);
export type PriorityTerm = z.infer<typeof PriorityTerm>;

/**
 * The data a visual draws, declared (widget pass: product's extended, declarative shape), so the hub and agents judge a
 * fit and rank visuals without client code (`rankVisuals` in `visuals.ts`): its channels, how many rows it draws,
 * whether it only tells the truth about a whole result, the rules its data must meet, how it stays honest when the
 * result is big, its styles, the args it can drive, its priority band and terms, and its page size if it pages. A
 * client may still veto a fit; it never scores one.
 */
export const VisualShape = z.object({
  channels: z.array(VisualChannel).min(1),
  rows: z.object({ min: z.number().int().min(0), max: z.number().int().min(1).optional() }),
  whole: z.boolean(),
  rules: z.array(VisualRule).default([]),
  size: VisualSizeStrategy.optional(),
  /** The styles the picker offers, the first the default. */
  styles: z.array(VisualStyle).min(1).default([{ name: 'default', label: 'Default' }]),
  claims: z.array(VisualClaim).default([]),
  priority: z.object({ band: PriorityBand, terms: z.array(PriorityTerm) }).default({ band: 'structural', terms: [] }),
  /** The display page size when the visual pages its rows (a table's 10); absent: it draws every row held. */
  pageSize: z.number().int().min(1).max(500).optional(),
});
export type VisualShape = z.infer<typeof VisualShape>;
/** A shape as an author writes it: the defaulted parts may be left out. */
export type VisualShapeInput = z.input<typeof VisualShape>;

/** A registry a system hosts (`Manifest.registries`): its name, what it is for, and the data every entry is given. */
export const RegistryDecl = z.object({
  name: LocalName,
  description: z.string(),
  /** The data each entry is drawn with (for query visuals, a `ResultTable`). */
  data: GinTypeDef,
});
export type RegistryDecl = z.infer<typeof RegistryDecl>;

/**
 * One entry a system adds to a registry (`Manifest.contributes`). Its component and match logic are in the system's
 * client bundle, under the same registry and name; this declaration tells the hub and the web app which bundles to load.
 */
export const ContributionDecl = z.object({
  /** The registry, qualified by the system that hosts it (`hub/visuals`). */
  registry: QualifiedName,
  name: LocalName,
  /** What the switcher shows ("Table", "Bar chart"). */
  label: z.string().min(1),
  description: z.string().optional(),
  /** An icon name from the web app's icon set. */
  icon: z.string().optional(),
  /**
   * What data a visual draws, declared so the hub and agents judge and rank a fit without client code (`rankVisuals`).
   * Widget pass: every visual of `hub/visuals` declares one; absent only for other registries.
   */
  shape: VisualShape.optional(),
});
export type ContributionDecl = z.infer<typeof ContributionDecl>;

/** A contribution as the web app lists it: with the system that adds it. */
export const ContributionView = ContributionDecl.extend({ system: SystemName });
export type ContributionView = z.infer<typeof ContributionView>;

// ─── Result tables ────────────────────────────────────────────────────────────


/** One column of a result: its name, label, kind, and its gin type when the source knows a more exact one. */
export const ResultColumn = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  kind: ColumnKind,
  nullable: z.boolean(),
  /** The column's gin type (an enum, a format, a range), when the query's row type gives one. */
  type: GinTypeDef.optional(),
  /** The named type a column refers to (a foreign key's table type), so a cell can link to its row. */
  ref: QualifiedName.optional(),
  /** Widget pass: what the column is for, when the source knows (a GROUP BY key, an aggregate); else derived. */
  role: ColumnRole.optional(),
  /** Widget pass: the column is the row's declared key (a natural key renders; a minted uuid key is hidden). */
  key: z.boolean().optional(),
  /** Widget pass: the person may change this column in place (a stored record's field on the Data page). */
  editable: z.boolean().optional(),
});
export type ResultColumn = z.infer<typeof ResultColumn>;

/** A sort a result was read with. */
export const ResultSort = z.object({ column: z.string().min(1), dir: z.enum(['asc', 'desc']) });
export type ResultSort = z.infer<typeof ResultSort>;

/**
 * Rows as the person sees them: columns once, then each row as an array in column order. `total` is there when the
 * source counted it; `truncated` says more rows exist past `offset + rows.length`.
 */
export const ResultTable = z.object({
  columns: z.array(ResultColumn),
  rows: z.array(z.array(Json)),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).optional(),
  total: z.number().int().min(0).optional(),
  truncated: z.boolean(),
  sort: z.array(ResultSort),
  /**
   * Widget pass: the rows came from a write (an update that shows what it changed), with how many rows it touched. A
   * view of them is read-only: no controls, no fetching more, no drill; row actions stay; "Run again" asks first.
   */
  write: z.object({ affected: z.number().int().min(0) }).optional(),
  /** Widget pass: the rows are records of a stored type, with the column holding each record's id (inline editing). */
  records: z.object({ type: QualifiedName, id: z.string().min(1) }).optional(),
});
export type ResultTable = z.infer<typeof ResultTable>;
