/**
 * A stored type's top-level fields, read off its gin definition: each field's column kind (for filters, sorts and the
 * result grid), whether it may be absent, and its gin type. Only an object type's own props are fields; a field of a
 * named or composite type is a `json` column, shown but neither filtered nor sorted.
 */
import { GinTypeDef, type ColumnKind, type FieldType, type ResultColumn } from '@harness/core';
import { z } from 'zod';

/** One top-level field of a stored type. */
export interface RecordField {
  readonly name: string;
  readonly kind: ColumnKind;
  readonly nullable: boolean;
  readonly type: GinTypeDef;
}

/** An object def's props, as gin writes them. */
const ObjDef = z.object({ name: z.literal('obj'), props: z.record(z.string(), z.object({ type: GinTypeDef })) });
/** A wrapper that makes its inner type optional or nullable. */
const Wrapped = z.object({ name: z.enum(['optional', 'nullable']), generic: z.object({ T: GinTypeDef }) });

/** The column kind of a gin type, by its name. */
const KINDS: Readonly<Record<string, ColumnKind>> = {
  text: 'text', string: 'text', email: 'text', url: 'text', uuid: 'uuid', num: 'number', number: 'number', int: 'integer', bool: 'boolean',
  timestamp: 'datetime', date: 'date', time: 'time', json: 'json', any: 'json',
};

/** An enum: its values are of its value type (`V`), text most often. */
const EnumDef = z.object({ name: z.literal('enum'), generic: z.object({ V: GinTypeDef }) });

/** The column kind of a field's type: an enum's is its value type's (so a status can be filtered), else by its name. */
function kindOf(type: GinTypeDef): ColumnKind {
  const choice = EnumDef.safeParse(type);
  return KINDS[choice.success ? choice.data.generic.V.name : type.name] ?? 'json';
}

/** A field's gin type with any optional or nullable wrapper taken off, and whether there was one. */
function unwrap(type: GinTypeDef): { readonly type: GinTypeDef; readonly nullable: boolean } {
  const wrapped = Wrapped.safeParse(type);
  return wrapped.success ? { type: unwrap(wrapped.data.generic.T).type, nullable: true } : { type, nullable: false };
}

/** The top-level fields of a stored type's definition (none for a type that is not an object). */
export function recordFields(def: GinTypeDef): RecordField[] {
  const obj = ObjDef.safeParse(def);
  if (!obj.success) { return []; }
  return Object.entries(obj.data.props).map(([name, prop]) => {
    const { type, nullable } = unwrap(prop.type);
    return { name, kind: kindOf(type), nullable, type };
  });
}

/** Whether a field can be filtered and sorted in the database: a scalar, not JSON or bytes. */
export function queryable(field: RecordField): boolean {
  return field.kind !== 'json' && field.kind !== 'binary';
}

/** How the query standard types a field, for its operators. */
export function fieldTypeOf(field: RecordField): FieldType {
  switch (field.kind) {
    case 'integer': case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'date': case 'datetime': return 'date';
    case 'text': case 'time': case 'uuid': case 'json': case 'binary': return 'text';
  }
}

/** A field as a result grid's column. */
export function columnOf(field: RecordField): ResultColumn {
  return { name: field.name, kind: field.kind, nullable: field.nullable, type: field.type };
}
