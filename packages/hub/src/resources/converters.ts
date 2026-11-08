/**
 * Converting raw content with `@aeye/resources`: one shared registry (`createDefaultResourceRegistry`) for the whole
 * hub, so a markdown page looks the same whichever path read it. A converted version is the library's own
 * `ResourceVersion` (core's `ConvertedVersion`), stored as JSON. Tables are capped at `HARNESS_TABLE_ROWS` rows each,
 * with the real counts kept in the version's metadata (`TableCounts`), so a huge sheet never fills a form.
 */
import { CODE_TYPES, type ResourceRegistry, type ResourceSource } from '@aeye/resources';
import { createDefaultResourceRegistry } from '@aeye/resources/default';
import { type CodeFormat, type ConvertedVersion, Section } from '@harness/core';
import { z } from 'zod';
import type { Converters } from './index.ts';

/** The prefix of every converter id made with the library, so forms record what made them. */
export const LIBRARY_CONVERTER = '@aeye/resources';

/** The library's code types, each a code format in core's families: a type added there fails to compile here until core lists it. */
export const LIBRARY_CODE_FORMATS: readonly CodeFormat[] = CODE_TYPES;

/** The real row count of each table of a capped table version, by table index (kept in its metadata). */
export const TableCounts = z.object({ tableRows: z.array(z.number().int().min(0)) });
export type TableCounts = z.infer<typeof TableCounts>;

/** The real row counts of a table version's tables (each table's own length when it wasn't capped). */
export function tableRowCounts(version: Extract<ConvertedVersion, { kind: 'table' }>): number[] {
  const counts = TableCounts.safeParse(version.metadata);
  return version.tables.map((table, i) => (counts.success ? counts.data.tableRows[i] : undefined) ?? table.rows.length);
}

/** A table version with at most `maxRows` rows per table and the real counts in its metadata. */
export function capTables(version: ConvertedVersion, maxRows: number): ConvertedVersion {
  if (version.kind !== 'table' || version.tables.every((table) => table.rows.length <= maxRows)) { return version; }
  const counts: TableCounts = { tableRows: version.tables.map((table) => table.rows.length) };
  return { ...version, tables: version.tables.map((table) => ({ ...table, rows: table.rows.slice(0, maxRows) })), metadata: { ...version.metadata, ...counts } };
}

/** What the library converters need. */
export interface RegistryConvertersOptions {
  /** Rows kept per table (`HARNESS_TABLE_ROWS`). */
  readonly maxRows: number;
  /** The registry to convert with (default: the library's built-ins). */
  readonly registry?: ResourceRegistry;
}

/** Converters over one `@aeye/resources` registry. */
export class RegistryConverters implements Converters {
  readonly #registry: ResourceRegistry;
  readonly #maxRows: number;

  constructor(options: RegistryConvertersOptions) {
    this.#registry = options.registry ?? createDefaultResourceRegistry();
    this.#maxRows = options.maxRows;
  }

  /**
   * The resource type of a location and mime type, by the library's rules: a specific mime wins, and a catch-all
   * `text/*` one (`text/typescript`) yields to the name's extension (`typescript`).
   */
  typeOf(location: string, mime?: string): string | undefined {
    return this.#registry.inferType(location, mime);
  }

  current(type: string): readonly string[] {
    return this.#registry.getConverters(type).map((converter) => `${LIBRARY_CONVERTER}:${converter.id}`);
  }

  async convert(input: { bytes: Uint8Array; type: string; location: string; name: string; mime?: string }): Promise<{ version: ConvertedVersion; converter: string } | undefined> {
    // the name is given, so the library never has to work it out from a location it can't read (a hub or remote URI)
    const source: ResourceSource = {
      location: input.location, name: input.name, input: input.bytes, type: input.type, size: input.bytes.length, ...(input.mime === undefined ? {} : { mimeType: input.mime }),
    };
    const version = await this.#registry.convertSource(source);
    return version === undefined ? undefined : { version: capTables(version, this.#maxRows), converter: `${LIBRARY_CONVERTER}:${version.converter}` };
  }

  sections(version: ConvertedVersion): Section[] {
    return this.#registry.sectionVersion(version).map((section) => Section.parse({ ...section, form: version.kind }));
  }
}
