/**
 * Rows to cells and back. A row is parsed with its table's schema before it is written and after it is read, so
 * nothing the schema refuses is ever stored or returned.
 */
import { z } from 'zod';
import type { Cell, StoredRow } from './db.ts';
import { StoreError, type StoreErrorCode } from './errors.ts';
import { type ColumnKind, KEY_COLUMN, type Layout } from './schema.ts';

/** A parsed row seen as a plain record, to walk its fields. */
const FieldRecord = z.record(z.string(), z.unknown());

/** Encode one field value for its column. `undefined` (an absent field) is SQL `NULL`. */
export function encodeCell(kind: ColumnKind, value: unknown, where: string, code: StoreErrorCode = 'invalid-row'): Cell {
  if (value === undefined) return null;
  switch (kind) {
    case 'json':
      return JSON.stringify(value);
    case 'bool':
      if (typeof value === 'boolean') return value ? 1 : 0;
      break;
    case 'integer':
    case 'real':
      if (typeof value === 'number') return value;
      break;
    case 'text':
      if (typeof value === 'string') return value;
      break;
  }
  throw new StoreError(code, `${where}: a ${kind} column can't hold ${JSON.stringify(value)}`);
}

/** Decode one cell back into a field value. `NULL` is an absent field. */
export function decodeCell(kind: ColumnKind, cell: Cell | undefined): unknown {
  if (cell === null || cell === undefined) return undefined;
  switch (kind) {
    case 'json':
      return typeof cell === 'string' ? JSON.parse(cell) : undefined;
    case 'bool':
      return Number(cell) !== 0;
    case 'integer':
    case 'real':
      return typeof cell === 'bigint' ? Number(cell) : cell;
    case 'text':
      return typeof cell === 'string' ? cell : String(cell);
  }
}

/**
 * What the codec needs of a table definition (core's `TableDef`), typed by the row it produces rather than by its
 * schema's class, so a table picked by a generic name keeps its row type.
 */
export interface RowDef<Row, Key> {
  readonly row: { safeParse(input: unknown): z.ZodSafeParseResult<Row> };
  /** The stored key of a row. */
  readonly rowKey: (row: Row) => string;
  /** The stored key from a reader's key (core's `KeyOf`). */
  readonly key: (key: Key) => string;
}

/** Encodes and decodes the rows of one table. */
export class RowCodec<Row, Key> {
  readonly table: string;
  readonly def: RowDef<Row, Key>;
  readonly layout: Layout;

  constructor(table: string, def: RowDef<Row, Key>, layout: Layout) {
    this.table = table;
    this.def = def;
    this.layout = layout;
  }

  /** Parse a row with the table's schema, refusing it with `invalid-row`. */
  parse(row: unknown): Row {
    const parsed = this.def.row.safeParse(row);
    if (!parsed.success) throw new StoreError('invalid-row', `table ${this.table}: ${z.prettifyError(parsed.error)}`, { cause: parsed.error });
    return parsed.data;
  }

  /** The key of a row. */
  keyOf(row: Row): string {
    return this.def.rowKey(row);
  }

  /** The stored key from a reader's key. */
  storedKey(key: Key): string {
    return this.def.key(key);
  }

  /** Parse a row and turn it into cells: its key and every column (`NULL` for absent fields). */
  encode(row: unknown): { row: Row; key: string; cells: StoredRow } {
    const parsed = this.parse(row);
    const fields = FieldRecord.parse(parsed);
    const key = this.keyOf(parsed);
    const cells: StoredRow = { [KEY_COLUMN]: key };
    for (const [column, kind] of this.layout) cells[column] = encodeCell(kind, fields[column], `${this.table}.${column}`);
    return { row: parsed, key, cells };
  }

  /** Turn stored cells back into a row, parsed with the table's schema. */
  decode(cells: StoredRow): Row {
    const fields: Record<string, unknown> = {};
    for (const [column, kind] of this.layout) {
      const value = decodeCell(kind, cells[column]);
      if (value !== undefined) fields[column] = value;
    }
    return this.parse(fields);
  }
}
