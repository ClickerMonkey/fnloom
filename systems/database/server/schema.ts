/**
 * A database's schema as the system reads it: `@aeye/query`'s `TableSpec` per table (the same shape its DDL writers
 * take), with a row estimate beside it. Each table hashes to a stable digest of its shape, so enrichment and type
 * patches only happen when it changes.
 */
import { createHash } from 'node:crypto';
import type { ColumnKind } from '@harness/core';
import { TableSpec, type ColumnType } from '@aeye/query';
import { z } from 'zod';

/** One table as scanned: its shape and roughly how many rows it has (for cost estimates; not part of its hash). */
export const ScannedTable = z.object({ spec: TableSpec, rows: z.number().int().min(0) });
export type ScannedTable = z.infer<typeof ScannedTable>;

/** A stable digest of a table's shape. */
export function schemaHash(spec: TableSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
}

/** The kind of value a column holds, as results report it. */
export function columnKind(type: ColumnType): ColumnKind {
  switch (type.kind) {
    case 'text': return 'text';
    case 'integer': return 'integer';
    case 'decimal': case 'float': return 'number';
    case 'bool': return 'boolean';
    case 'date': return 'date';
    case 'timestamp': return 'datetime';
    case 'uuid': return 'uuid';
    case 'json': return 'json';
    case 'bytes': return 'binary';
    case 'other': return /^time/i.test(type.native) ? 'time' : 'text';
  }
}

/** The values of a check constraint like `CHECK (status IN ('open', 'paid'))` for a column, if it has one. */
export function checkValues(checkSql: string, column: string): string[] | undefined {
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`["\`\\[]?${name}["\`\\]]?\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(checkSql);
  if (match?.[1] === undefined) { return undefined; }
  const values = [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((value) => (value[1] ?? '').replace(/''/g, '\''));
  return values.length > 0 ? values : undefined;
}

/** The values of SQL Server's spelling of an IN check: `([status]='open' OR [status]='paid')`. */
export function orValues(definition: string, column: string): string[] | undefined {
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const values = [...definition.matchAll(new RegExp(`\\[${name}\\]\\s*=\\s*N?'((?:[^']|'')*)'`, 'gi'))].map((match) => (match[1] ?? '').replace(/''/g, '\''));
  return values.length > 0 ? values : undefined;
}

/** The values of Postgres's spelling of an IN check: `(tier)::text = ANY ((ARRAY['basic'::character varying, …])::text[])`. */
export function anyValues(definition: string, column: string): string[] | undefined {
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\(?"?${name}"?\\)?(?:::[\\w ]+)?\\s*=\\s*ANY\\s*\\(+ARRAY\\[([^\\]]*)\\]`, 'i').exec(definition);
  if (match?.[1] === undefined) { return undefined; }
  const values = [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((value) => (value[1] ?? '').replace(/''/g, '\''));
  return values.length > 0 ? values : undefined;
}
