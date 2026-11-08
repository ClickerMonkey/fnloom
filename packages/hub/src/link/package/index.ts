/**
 * `@harness/hub/package`: the system package and data export formats, shared by the hub (which checks and unpacks
 * them) and the `harness` CLI (which makes them). Node only.
 */
export { zip, unzip, ZipError, type ZipEntry } from './zip.ts';
export { PackageError, checkManifest, manifestBytes, pathProblems, readPackage, readTree, sealPackage, writeTree, type CheckedPackage } from './format.ts';
/** The sha-256 of a package file, hex (the hub's one digest helper). */
export { sha256Hex as sha256 } from '../keys.ts';
export { EXPORT_FILES, readExport, sealExport, type DataExport } from './data.ts';
