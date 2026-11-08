/**
 * The data export format: a zip with `export.json` (`SystemDataExport`), the instance's data folder under `data/`,
 * and `config.json` (the instance's config value) only when the export was made with secrets. `harness system
 * export-data` downloads one; `harness system install --data` hands it back to restore an instance.
 */
import { Json, SystemDataExport } from '@harness/core';
import { PackageError, parseJson, pathProblems } from './format.ts';
import type { ZipEntry } from './zip.ts';

/** The file names inside a data export. */
export const EXPORT_FILES = { info: 'export.json', config: 'config.json', data: 'data/' } as const;

/** A read data export. */
export interface DataExport {
  readonly info: SystemDataExport;
  /** The config value, when the export carries it. */
  readonly config?: Json | undefined;
  /** The data folder's files, relative to it. */
  readonly data: readonly ZipEntry[];
}

/** JSON as bytes. */
function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** The entries of a data export. */
export function sealExport(exported: DataExport): ZipEntry[] {
  const info = SystemDataExport.parse(exported.info);
  if (info.withSecrets !== (exported.config !== undefined)) { throw new PackageError(['an export carries its config exactly when it is made with secrets']); }
  return [
    { path: EXPORT_FILES.info, bytes: jsonBytes(info) },
    ...(exported.config === undefined ? [] : [{ path: EXPORT_FILES.config, bytes: jsonBytes(exported.config) }]),
    ...exported.data.map((file) => ({ path: `${EXPORT_FILES.data}${file.path}`, bytes: file.bytes })),
  ];
}

/** Read and check a data export's entries. */
export function readExport(entries: readonly ZipEntry[]): DataExport {
  const problems = entries.flatMap((e) => pathProblems(e.path));
  const infoEntry = entries.find((e) => e.path === EXPORT_FILES.info);
  const info = SystemDataExport.safeParse(infoEntry === undefined ? undefined : parseJson(infoEntry.bytes));
  if (!info.success) { throw new PackageError([...problems, `${EXPORT_FILES.info} is missing or not a data export`]); }
  const configEntry = entries.find((e) => e.path === EXPORT_FILES.config);
  const config = configEntry === undefined ? undefined : Json.safeParse(parseJson(configEntry.bytes));
  if (config?.success === false) { problems.push(`${EXPORT_FILES.config} is not JSON`); }
  for (const entry of entries) {
    if (entry.path !== EXPORT_FILES.info && entry.path !== EXPORT_FILES.config && !entry.path.startsWith(EXPORT_FILES.data)) { problems.push(`${entry.path} doesn't belong in a data export`); }
  }
  if (problems.length > 0) { throw new PackageError(problems); }
  const data = entries.filter((e) => e.path.startsWith(EXPORT_FILES.data)).map((e) => ({ path: e.path.slice(EXPORT_FILES.data.length), bytes: e.bytes }));
  return { info: info.data, ...(config?.success === true ? { config: config.data } : {}), data };
}
