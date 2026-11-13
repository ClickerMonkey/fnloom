/**
 * The data system (build 8): records of stored types, kept and searched by the hub. A type becomes stored when its
 * declaration has `records` (`TypeDecl.records`), in a contract or added while running, so a stored type has the same
 * origin, visibility and version history as any type. Its records live in the hub's `records` table (the value as
 * JSON, checked against the type), with a version per change in `recordVersions`, and are found by the hub database:
 * filters and sorts on the type's fields (`ListQuery`), text search over the fields `records.search.text` names, and
 * semantic search when `records.search.embed` is set. No system keeps its own store of shared data and nothing loads a
 * whole set: every read is a query with a page.
 *
 * Two shapes, after product's data pieces: `table` (many records, the usual) and `value` (one record, such as a
 * system's shared settings or a list it keeps). Secrets stay in the hub's sealed secrets, never in records.
 *
 * Who sees a record: everyone who can see its type (`TypeDecl.audience`, else its system's), or, for a type with
 * `owner: 'person'`, only the person who owns it (and admins). Systems read and write as the run's person through the
 * hub link; the web app's Data page (`/data/:type`) and the hub fns `hub/records_*` do the same.
 */
import { z } from 'zod';
import { ListQuery } from './query.ts';
import { ActorId, IDS, Json, PageRequest, QualifiedName, RunId, SystemName, Timestamp, page } from './primitives.ts';

/** A record's id. */
export const RecordId = IDS.record;
export type RecordId = z.infer<typeof RecordId>;

/** How a stored type keeps its records (`TypeDecl.records`). */
export const RecordStorage = z.object({
  /** Many records, or exactly one. */
  shape: z.enum(['table', 'value']),
  /** Whether each record belongs to one person (only they and admins see it) or to everyone who sees the type. */
  owner: z.enum(['shared', 'person']),
  search: z.object({
    /** Top-level text fields matched by text search, in order of weight. */
    text: z.array(z.string().min(1)),
    /** Whether records are embedded for semantic search (by the hub's embedder, as a model call). */
    embed: z.boolean(),
  }),
});
export type RecordStorage = z.infer<typeof RecordStorage>;

/** One record (the `records` table). */
export const DataRecord = z.object({
  id: RecordId,
  /** The stored type's qualified name. */
  type: QualifiedName,
  value: Json,
  /** Its owner, for a type with `owner: 'person'`. */
  owner: ActorId.optional(),
  /** Its title, from the type's `display.title` field, for lists and mentions. */
  title: z.string(),
  /** Counts up from 1 with every change; a save may name the version it changes (`expect`). */
  version: z.number().int().min(1),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Who made the last change: a person, and the system and run when one made it. */
  updatedBy: ActorId.optional(),
  updatedBySystem: SystemName.optional(),
  run: RunId.optional(),
});
export type DataRecord = z.infer<typeof DataRecord>;

/** One earlier or current version of a record (the `recordVersions` table). */
export const RecordVersion = z.object({
  /** `<record>#<number>`. */
  id: z.string().min(1),
  record: RecordId,
  type: QualifiedName,
  number: z.number().int().min(1),
  change: z.enum(['created', 'updated', 'removed']),
  value: Json,
  by: ActorId.optional(),
  bySystem: SystemName.optional(),
  run: RunId.optional(),
  at: Timestamp,
});
export type RecordVersion = z.infer<typeof RecordVersion>;

/** The id of one record version. */
export function recordVersionId(record: RecordId, number: number): string {
  return `${record}#${String(number)}`;
}

/**
 * Records of one stored type: `query` filters and sorts on the type's top-level fields (the hub refuses an unknown
 * field), `search` ranks by text and meaning; `mine` keeps a person-owned type to the asker's own (admins see all).
 */
export const RecordQuery = z.object({
  type: QualifiedName,
  query: ListQuery.optional(),
  search: z.string().min(1).optional(),
  run: RunId.optional(),
});
export type RecordQuery = z.infer<typeof RecordQuery>;

export const RecordPage = page(DataRecord);
export type RecordPage = z.infer<typeof RecordPage>;

/**
 * The same records as a `ResultTable` (`hub/records_table`), which widgets and the result view draw: one column per
 * top-level field of the type, then `id` with `ref` set to the type, so actions find each row's record.
 */
export const RecordTableQuery = RecordQuery.extend({
  query: ListQuery.omit({ cursor: true, limit: true }).optional(),
  /** Offset paging, which a widget's pager drives (`WidgetPaging`). */
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type RecordTableQuery = z.infer<typeof RecordTableQuery>;

/** Get one record. */
export const RecordGet = z.object({ type: QualifiedName, id: RecordId, run: RunId.optional() });
export type RecordGet = z.infer<typeof RecordGet>;

/**
 * Add a record (no `id`) or replace one; for a `value` type there is one record and `id` is left out. `expect` makes the
 * save fail when the record moved on past that version (two people editing at once).
 */
export const RecordSave = z.object({
  type: QualifiedName,
  id: RecordId.optional(),
  value: Json,
  expect: z.number().int().min(1).optional(),
  run: RunId.optional(),
});
export type RecordSave = z.infer<typeof RecordSave>;

/**
 * Widget pass: change some top-level fields of one record in place (the Data grid's inline edit), the rest kept. The
 * merged value is checked against the type; `expect` refuses the change when the record moved on past that version.
 */
export const RecordUpdate = z.object({
  type: QualifiedName,
  id: RecordId,
  set: z.record(z.string().min(1), Json).refine((set) => Object.keys(set).length > 0, 'set at least one field'),
  expect: z.number().int().min(1).optional(),
  run: RunId.optional(),
});
export type RecordUpdate = z.infer<typeof RecordUpdate>;

/** Remove a record; its versions stay. */
export const RecordRemove = z.object({ type: QualifiedName, id: RecordId, run: RunId.optional() });
export type RecordRemove = z.infer<typeof RecordRemove>;

/** A record's history, newest first. */
export const RecordVersionsQuery = PageRequest.extend({ type: QualifiedName, id: RecordId });
export type RecordVersionsQuery = z.infer<typeof RecordVersionsQuery>;

export const RecordVersionsPage = page(RecordVersion);
export type RecordVersionsPage = z.infer<typeof RecordVersionsPage>;

/** A stored type as the Data page lists it: the type, its storage and how many records the asker sees. */
export const DataSetView = z.object({
  type: QualifiedName,
  system: SystemName,
  description: z.string(),
  storage: RecordStorage,
  records: z.number().int().min(0),
  updatedAt: Timestamp.optional(),
});
export type DataSetView = z.infer<typeof DataSetView>;

/** The stored types the asker sees, by text and system. */
export const DataSetQuery = PageRequest.extend({ text: z.string().optional(), system: SystemName.optional() });
export type DataSetQuery = z.infer<typeof DataSetQuery>;

export const DataSetPage = page(DataSetView);
export type DataSetPage = z.infer<typeof DataSetPage>;
