/**
 * Registries (build 5): a system declares a registry of components, and any system (itself included) contributes
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

/** The kinds of value a result column holds, for formatting and for visuals' match logic. */
export const COLUMN_KINDS = ['text', 'integer', 'number', 'boolean', 'date', 'datetime', 'time', 'uuid', 'json', 'binary'] as const;
export const ColumnKind = z.enum(COLUMN_KINDS);
export type ColumnKind = z.infer<typeof ColumnKind>;

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
