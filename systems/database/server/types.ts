/**
 * Tables as types, both ways the system needs them:
 *
 * - **The hub's type** (`<instance>.<table>`): `@aeye/query`'s `tableToGinType` (columns, nullability, defaults,
 *   keys, foreign keys in the docs), refined by the table's enrichment when there is one (choices, formats, ranges,
 *   descriptions, examples).
 * - **The query engine's type**: an `@aeye/query` `TypeDef` per table, with each single-column foreign key as a
 *   `relation` field the model can join over (its physical key in the backing), and the enrichment's descriptions.
 */
import type { PropDef, TypeDef as GinDef } from '@aeye/gin';
import { Value, tableToGinType, type ColumnSpec, type ColumnType, type FieldDef, type FieldTypeDef, type TableSpec, type TypeBacking, type TypeDef } from '@aeye/query';
import { GinTypeDef, slashedName, type QualifiedName } from '@harness/core';
import { z } from 'zod';
import type { ScannedTable } from './schema.ts';

// ─── Enrichment ──────────────────────────────────────────────────────────────

/** Formats enrichment may give a text column. */
export const TextFormat = z.enum(['email', 'url', 'uuid', 'phone', 'iso-date', 'country-code', 'currency-code']);
export type TextFormat = z.infer<typeof TextFormat>;

/** The pattern each format becomes. */
export const FORMAT_PATTERNS: Readonly<Record<TextFormat, string>> = {
  email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  url: '^https?://\\S+$',
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  phone: '^\\+?[0-9 ().-]{6,}$',
  'iso-date': '^\\d{4}-\\d{2}-\\d{2}$',
  'country-code': '^[A-Z]{2}$',
  'currency-code': '^[A-Z]{3}$',
};

/** What a model adds to one column. */
export const ColumnEnrichment = z.object({
  description: z.string().min(1).optional().describe('What the column holds.'),
  /** The closed set of values the column holds (a status, a category), when it clearly has one. */
  values: z.array(z.union([z.string(), z.number()])).min(1).max(40).optional()
    .describe('The closed set of values, only when the column clearly holds one: a status, a type, a category.'),
  format: TextFormat.optional().describe('The format of a text column, when every value has it.'),
  min: z.number().optional().describe('The smallest value, only for a clear bound like a percentage or a rating.'),
  max: z.number().optional().describe('The largest value, only for a clear bound like a percentage or a rating.'),
  examples: z.array(z.string()).max(5).optional().describe('Up to 3 typical values, as text.'),
});
export type ColumnEnrichment = z.infer<typeof ColumnEnrichment>;

/** What a model adds to one table's type. */
export const TableEnrichment = z.object({
  description: z.string().min(1).describe('One sentence on what a row is.'),
  columns: z.record(z.string(), ColumnEnrichment),
});
export type TableEnrichment = z.infer<typeof TableEnrichment>;

/**
 * The enricher's answer: `TableEnrichment` with its columns as a list, each naming its column, since a structured
 * answer can't have keys of the model's choosing (`enrichmentOf` turns it back into the kept shape).
 */
export const EnrichmentAnswer = TableEnrichment.extend({
  columns: z.array(ColumnEnrichment.extend({ column: z.string().min(1).describe('The column\'s name, exactly as given.') }))
    .describe('Only the columns there is something sure to say about.'),
});
export type EnrichmentAnswer = z.infer<typeof EnrichmentAnswer>;

/** An answer as the enrichment kept with the type, keeping only columns the table has. */
export function enrichmentOf(answer: EnrichmentAnswer, columns: ReadonlySet<string>): TableEnrichment {
  const kept = answer.columns.filter((entry) => columns.has(entry.column)).map(({ column, ...rest }) => [column, rest] as const);
  return { description: answer.description, columns: Object.fromEntries(kept) };
}

/**
 * What the system keeps with each table type in the hub (`TypeDecl.meta`, read back through `ctx.types`): the schema
 * hash of the table the type was made from, and its enrichment when a model made one. So a model refines a table once
 * per schema, and the system keeps no store of its own.
 */
export const TableMeta = z.object({
  schemaHash: z.string().min(1),
  enrichment: TableEnrichment.optional(),
});
export type TableMeta = z.infer<typeof TableMeta>;

/** A table type as the hub keeps it: its definition and the meta it was sent with (absent on a type sent before meta). */
export interface KeptType {
  readonly def: GinTypeDef;
  readonly meta: TableMeta | undefined;
}

/** The meta the hub returned with a type, when it is a table type's meta. */
export function tableMetaOf(meta: unknown): TableMeta | undefined {
  const parsed = TableMeta.safeParse(meta);
  return parsed.success ? parsed.data : undefined;
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** A table or column name as an identifier the type systems accept (`order items` becomes `order_items`). */
export function identifierOf(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(id) ? id : `_${id}`;
}

/** The hub's local name of a table's type: `<instance>.<table>`. */
export function typeNameOf(instance: string, table: string): string {
  return `${instance}.${identifierOf(table)}`;
}

/** The qualified hub name of a table's type. */
export function qualifiedTypeOf(instance: string, table: string): QualifiedName {
  return `database/${typeNameOf(instance, table)}`;
}

/**
 * A table as a `table` arg may name it, read as the table and the instance it names (if any): its name (`expenses`),
 * its type's local name (`main.expenses`), its type (`database/main.expenses`), or that type in the tools' spelling
 * (`database__main__expenses`), so whichever spelling the model or a person copies finds the table.
 */
export function tableRefOf(given: string): { readonly instance?: string; readonly table: string } {
  const trimmed = given.trim();
  const name = trimmed.startsWith('database__') ? slashedName(trimmed) : trimmed;
  const local = name.startsWith('database/') ? name.slice('database/'.length) : name;
  const dot = local.indexOf('.');
  return dot > 0 && dot < local.length - 1 ? { instance: local.slice(0, dot), table: local.slice(dot + 1) } : { table: local };
}

// ─── The hub's type ──────────────────────────────────────────────────────────

const GinOptions = z.record(z.string(), z.unknown());
const EnumOptions = z.object({ values: z.record(z.string(), z.union([z.string(), z.number()])) });

/** A gin def's options, as a plain record (none when it has none). */
export function ginOptions(def: GinDef): Record<string, unknown> {
  const parsed = GinOptions.safeParse(def.options);
  return parsed.success ? { ...parsed.data } : {};
}

/** The values of a gin enum def (none for another def). */
export function enumValuesOf(def: GinDef): (string | number)[] {
  const parsed = EnumOptions.safeParse(def.options);
  return def.name === 'enum' && parsed.success ? Object.values(parsed.data.values) : [];
}

/** A scalar gin def refined by a column's enrichment. */
function refined(base: GinDef, column: ColumnEnrichment): GinDef {
  const options = ginOptions(base);
  if (column.values !== undefined && (base.name === 'text' || base.name === 'num')) {
    const values: Record<string, string | number> = {};
    for (const value of column.values) { values[String(value)] = value; }
    return { name: 'enum', generic: { V: base }, options: { values } };
  }
  if (base.name === 'text' && column.format !== undefined) { options['pattern'] = FORMAT_PATTERNS[column.format]; }
  if (base.name === 'num' && column.min !== undefined) { options['min'] = column.min; }
  if (base.name === 'num' && column.max !== undefined) { options['max'] = column.max; }
  return Object.keys(options).length === 0 ? { name: base.name } : { ...base, options };
}

/** A prop refined by its column's enrichment: the scalar under any `nullable`, and its docs. */
function refinedProp(prop: PropDef, column: ColumnEnrichment | undefined): PropDef {
  if (column === undefined) { return prop; }
  const nullable = prop.type.name === 'nullable';
  const inner = nullable ? (prop.type.generic?.['T'] ?? { name: 'any' }) : prop.type;
  // a column that already has a closed set keeps it
  const scalar = inner.name === 'enum' ? inner : refined(inner, column);
  const docs = [column.description, prop.docs, column.examples === undefined ? undefined : `E.g. ${column.examples.join(', ')}.`].filter((part): part is string => part !== undefined && part !== '');
  return { ...prop, type: nullable ? { name: 'nullable', generic: { T: scalar } } : scalar, ...(docs.length === 0 ? {} : { docs: docs.join(' ') }) };
}

/** The hub's gin type of a table's rows, refined by its enrichment when there is one. */
export function hubTypeOf(spec: TableSpec, enrichment?: TableEnrichment): GinTypeDef {
  const base = tableToGinType(spec);
  if (enrichment === undefined) { return GinTypeDef.parse(base); }
  const props: Record<string, PropDef> = {};
  for (const [name, prop] of Object.entries(base.props ?? {})) { props[name] = refinedProp(prop, enrichment.columns[name]); }
  return GinTypeDef.parse({ ...base, docs: `${enrichment.description} ${base.docs ?? ''}`.trim(), props });
}

/** The field a type's title is read from: a name-like text column, else none. */
export function titleOf(spec: TableSpec): string | undefined {
  const text = spec.columns.filter((column) => column.type.kind === 'text');
  return (text.find((column) => /^(name|title|label|full_?name|display_?name)$/i.test(column.name)) ?? text.find((column) => /name|title/i.test(column.name)))?.name;
}

// ─── The query engine's type ─────────────────────────────────────────────────

/** A column's field type in the query engine. */
export function fieldTypeOf(type: ColumnType, values?: ColumnSpec['values']): FieldTypeDef {
  const members = values === undefined ? {} : { values: values.map((value) => ({ value })) };
  switch (type.kind) {
    case 'text': return { kind: 'text', ...(type.maxLength === undefined ? {} : { maxLength: type.maxLength }), ...members };
    case 'integer': return { kind: 'number', whole: true, ...members };
    case 'decimal': return { kind: 'number', ...(type.scale === undefined ? {} : { maxPlaces: type.scale }), ...members };
    case 'float': return { kind: 'number', ...members };
    case 'bool': return { kind: 'bool' };
    case 'date': return { kind: 'date' };
    case 'timestamp': return { kind: 'timestamp', ...(type.timezone === undefined ? {} : { timezone: type.timezone }) };
    case 'uuid': return { kind: 'text', casing: 'exact' };
    case 'json': return { kind: 'json' };
    case 'bytes': case 'other': return { kind: 'text', ...members };
  }
}

/** A relation field's name for a foreign key column: `customer_id` becomes `customer`, never clashing with a column. */
function relationName(column: string, taken: ReadonlySet<string>): string {
  const base = column.replace(/(_id|Id|_key)$/, '');
  for (const candidate of [base, `${column}_ref`, `${column}_row`]) {
    if (candidate !== '' && candidate !== column && !taken.has(candidate)) { return candidate; }
  }
  return `${column}_${taken.size}`;
}

/** An engine type, and the backing that maps it to its physical table and keys. */
export interface EngineType {
  readonly def: TypeDef;
  readonly backing: TypeBacking;
}

/** The query engine's type of one table (and its backing), refined by the enrichment's descriptions. */
export function engineTypeOf(table: ScannedTable, enrichment?: TableEnrichment): EngineType {
  const spec = table.spec;
  const name = identifierOf(spec.name);
  const taken = new Set(spec.columns.map((column) => identifierOf(column.name)));
  const backingFields: NonNullable<TypeBacking['fields']> = {};
  const fields: FieldDef[] = spec.columns.map((column) => {
    const field = identifierOf(column.name);
    const extra = enrichment?.columns[column.name];
    const usual = extra?.values !== undefined && column.values === undefined ? `Usually one of: ${extra.values.join(', ')}.` : undefined;
    const description = [extra?.description, usual].filter((part): part is string => part !== undefined).join(' ');
    const optionalOnInsert = column.generated === true || column.default !== undefined;
    if (field !== column.name || optionalOnInsert) {
      backingFields[field] = { ...(field === column.name ? {} : { name: column.name }), ...(optionalOnInsert ? { default: Value.null() } : {}) };
    }
    return {
      name: field,
      type: fieldTypeOf(column.type, column.values),
      nullable: column.nullable,
      ...(description === '' ? {} : { description }),
      ...(column.generated === true ? { insertable: false, updatable: false } : {}),
    };
  });
  for (const key of spec.foreignKeys) {
    const [local] = key.columns;
    if (key.columns.length !== 1 || local === undefined) { continue; }
    const relation = relationName(identifierOf(local), taken);
    taken.add(relation);
    fields.push({ name: relation, type: { kind: 'relation', to: identifierOf(key.table), count: 1 }, nullable: spec.columns.find((column) => column.name === local)?.nullable ?? true, insertable: false, updatable: false, description: `The ${key.table} row ${local} refers to.` });
    backingFields[relation] = { relation: { keys: [{ local, foreign: key.references[0] ?? 'id' }] } };
  }
  const def: TypeDef = {
    name,
    fields,
    count: Math.max(table.rows, 1),
    ...(spec.primaryKey.length === 0 ? {} : { identity: spec.primaryKey.length === 1 ? identifierOf(spec.primaryKey[0] ?? '') : spec.primaryKey.map(identifierOf) }),
    ...(enrichment === undefined ? {} : { description: enrichment.description }),
  };
  return { def, backing: { ...(name === spec.name ? {} : { name: spec.name }), fields: backingFields } };
}
