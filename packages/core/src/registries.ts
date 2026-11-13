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
 * One input of a visual (build 8): a named slot that columns bind to ("label", "value", "start"), the column kinds it
 * takes, whether it must be bound, and whether it takes several columns (the series of a line chart).
 */
export const VisualChannel = z.object({
  name: LocalName,
  label: z.string().min(1),
  accepts: z.array(ColumnKind).min(1),
  required: z.boolean(),
  many: z.boolean(),
});
export type VisualChannel = z.infer<typeof VisualChannel>;

/**
 * The data a visual draws (build 8): its channels, how many rows it shows well, and whether it only tells the truth
 * about a whole result (a pie of one page lies, so `whole` visuals are refused for a partial table unless the widget
 * pages it).
 */
export const VisualShape = z.object({
  channels: z.array(VisualChannel).min(1),
  rows: z.object({ min: z.number().int().min(0), max: z.number().int().min(1).optional() }),
  whole: z.boolean(),
});
export type VisualShape = z.infer<typeof VisualShape>;

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
  /** The registry, qualified by the system that hosts it (`database/query-visuals`). */
  registry: QualifiedName,
  name: LocalName,
  /** What the switcher shows ("Table", "Bar chart"). */
  label: z.string().min(1),
  description: z.string().optional(),
  /** An icon name from the web app's icon set. */
  icon: z.string().optional(),
  /**
   * Build 8: what data a visual can draw, declared so the hub and agents can judge a fit without the client code
   * (`declaredFit`); the client's match logic still scores it. Absent: only the client can tell.
   */
  shape: VisualShape.optional(),
});
export type ContributionDecl = z.infer<typeof ContributionDecl>;

/** A contribution as the web app lists it: with the system that adds it. */
export const ContributionView = ContributionDecl.extend({ system: SystemName });
export type ContributionView = z.infer<typeof ContributionView>;

/**
 * What a visual's match logic answers for some data: whether it can draw it at all, and how much of it it shows well,
 * from 0 (shows it, poorly) to 1 (shows all of it as well as it can be shown). The table always fits with score 0.
 */
export const VisualFit = z.object({ fits: z.boolean(), score: z.number().min(0).max(1) });
export type VisualFit = z.infer<typeof VisualFit>;

/** The table visual's score: every other visual that fits beats it. */
export const TABLE_VISUAL_SCORE = 0;

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
});
export type ResultTable = z.infer<typeof ResultTable>;

// ─── The built-in query visuals' fits ─────────────────────────────────────────
// One match logic for the app's own visuals and the database system's, so a result fits the same way everywhere.

/** The table fits every result, with the lowest score. */
export function tableFit(): VisualFit {
  return { fits: true, score: TABLE_VISUAL_SCORE };
}

const BAR_LABEL_KIND_LIST = ['text', 'date', 'datetime'] as const satisfies readonly ColumnKind[];
const BAR_NUMBER_KIND_LIST = ['integer', 'number'] as const satisfies readonly ColumnKind[];
const BAR_LABEL_KINDS: ReadonlySet<ColumnKind> = new Set(BAR_LABEL_KIND_LIST);
const BAR_NUMBER_KINDS: ReadonlySet<ColumnKind> = new Set(BAR_NUMBER_KIND_LIST);
/** The most bars a chart draws before a table reads better. */
export const BAR_MAX_ROWS = 50;

/**
 * A bar chart fits one label column (text or a date) plus one number column, 2 to `BAR_MAX_ROWS` rows, every value a
 * number at or above 0. It shows such data best (0.8), less so when the rows are only part of the result (0.5).
 */
export function barFit(table: ResultTable): VisualFit {
  const [first, second] = table.columns;
  const no: VisualFit = { fits: false, score: 0 };
  if (table.columns.length !== 2 || first === undefined || second === undefined) { return no; }
  if (!BAR_LABEL_KINDS.has(first.kind) || !BAR_NUMBER_KINDS.has(second.kind)) { return no; }
  if (table.rows.length < 2 || table.rows.length > BAR_MAX_ROWS) { return no; }
  if (!table.rows.every((row) => typeof row[1] === 'number' && Number.isFinite(row[1]) && row[1] >= 0)) { return no; }
  return { fits: true, score: table.truncated || table.offset > 0 ? 0.5 : 0.8 };
}

/**
 * The built-in visuals' declared shapes (build 8), beside their match logic so both say the same thing: the table
 * draws any columns, the bar chart a label and a number column in 2 to `BAR_MAX_ROWS` rows, the value one cell of a
 * whole result. The database system contributes its visuals with these, and the app's own visuals use them too.
 */
export const BUILT_IN_SHAPES: Readonly<Record<'table' | 'bar' | 'value', VisualShape>> = {
  table: {
    channels: [{ name: 'columns', label: 'Columns', accepts: [...COLUMN_KINDS], required: false, many: true }],
    rows: { min: 0 },
    whole: false,
  },
  bar: {
    channels: [
      { name: 'label', label: 'Label', accepts: [...BAR_LABEL_KIND_LIST], required: true, many: false },
      { name: 'value', label: 'Value', accepts: [...BAR_NUMBER_KIND_LIST], required: true, many: false },
    ],
    rows: { min: 2, max: BAR_MAX_ROWS },
    whole: false,
  },
  value: {
    channels: [{ name: 'value', label: 'Value', accepts: [...COLUMN_KINDS], required: true, many: false }],
    rows: { min: 1, max: 1 },
    whole: true,
  },
};

/** A single value fits one row of one column, the whole result, and shows it best of all (0.9). */
export function valueFit(table: ResultTable): VisualFit {
  return table.columns.length === 1 && table.rows.length === 1 && table.offset === 0 && !table.truncated ? { fits: true, score: 0.9 } : { fits: false, score: 0 };
}
