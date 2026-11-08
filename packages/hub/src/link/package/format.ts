/**
 * The system package format: a zip of a built system folder, `system.json` (`SystemPackageManifest`) at its root with
 * the sha-256 of every other file in `files`. `harness system pack` seals a folder (`sealPackage`); the hub checks a
 * zip before it places it (`readPackage`): every path stays inside the folder, the manifest parses, it speaks this
 * hub's link protocol, every file is listed with its hash and nothing else is there, and its entries exist. Hashes
 * catch corruption, not malice: a package is code that runs as the hub's user.
 */
import { sha256Hex } from '../keys.ts';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { LINK_PROTOCOL, PACKAGE_MANIFEST_FILE, PackagePath, SystemPackageManifest } from '@harness/core';
import type { ZipEntry } from './zip.ts';

/** Why a package (or a data export) was refused, with every problem found. */
export class PackageError extends Error {
  override readonly name = 'PackageError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.problems = problems;
  }
}

/** A checked package: its manifest and its other files. */
export interface CheckedPackage {
  readonly manifest: SystemPackageManifest;
  readonly files: readonly ZipEntry[];
}

/** The manifest as `pack` writes it: two-space JSON with a final newline. */
export function manifestBytes(manifest: SystemPackageManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Seal a built folder's files into package entries: `system.json` first with every other file's hash in `files`,
 * then the files in path order. Paths are checked like `readPackage` checks them, so a pack can't make a package the
 * hub refuses.
 */
export function sealPackage(manifest: SystemPackageManifest, files: readonly ZipEntry[]): ZipEntry[] {
  const others = files.filter((f) => f.path !== PACKAGE_MANIFEST_FILE).sort((a, b) => a.path.localeCompare(b.path));
  const problems = others.flatMap((f) => pathProblems(f.path));
  if (problems.length > 0) { throw new PackageError(problems); }
  const sealed = SystemPackageManifest.parse({ ...manifest, files: Object.fromEntries(others.map((f) => [f.path, sha256Hex(f.bytes)])) });
  return [{ path: PACKAGE_MANIFEST_FILE, bytes: manifestBytes(sealed) }, ...others];
}

/** Check a package's entries and return its manifest and files; refused with every problem found. */
export function readPackage(entries: readonly ZipEntry[], protocol: number = LINK_PROTOCOL): CheckedPackage {
  const problems = entries.flatMap((e) => pathProblems(e.path));
  const manifestEntry = entries.find((e) => e.path === PACKAGE_MANIFEST_FILE);
  if (manifestEntry === undefined) { throw new PackageError([...problems, `there is no ${PACKAGE_MANIFEST_FILE}`]); }
  const checked = checkManifest(manifestEntry.bytes, protocol);
  problems.push(...checked.problems);
  const { manifest } = checked;
  if (manifest === undefined) { throw new PackageError(problems); }
  const files = entries.filter((e) => e.path !== PACKAGE_MANIFEST_FILE);
  const listed = manifest.files;
  if (listed === undefined) {
    problems.push(`${PACKAGE_MANIFEST_FILE} lists no file hashes: make the zip with \`harness system pack\``);
  } else {
    const present = new Set(files.map((f) => f.path));
    for (const file of files) {
      const hash = listed[file.path];
      if (hash === undefined) { problems.push(`${file.path} is not listed in ${PACKAGE_MANIFEST_FILE}`); }
      else if (hash !== sha256Hex(file.bytes)) { problems.push(`${file.path} doesn't match its hash`); }
    }
    for (const path of Object.keys(listed)) { if (!present.has(path)) { problems.push(`${path} is listed but missing`); } }
  }
  const entryPaths = [manifest.server.entry, ...(manifest.client === undefined ? [] : [manifest.client.entry])];
  for (const entry of entryPaths) { if (!files.some((f) => f.path === entry || f.path.startsWith(`${entry}/`))) { problems.push(`its entry ${entry} is missing`); } }
  if (problems.length > 0) { throw new PackageError(problems); }
  return { manifest, files };
}

/**
 * Parse a `system.json` and check it speaks this hub's link protocol: the manifest when it parses, and every problem
 * found. The one manifest check, for zips (`readPackage`) and installed folders (`readManifest`).
 */
export function checkManifest(bytes: Uint8Array, protocol: number = LINK_PROTOCOL): { manifest: SystemPackageManifest | undefined; problems: string[] } {
  const parsed = SystemPackageManifest.safeParse(parseJson(bytes));
  if (!parsed.success) { return { manifest: undefined, problems: parsed.error.issues.map((i) => `${PACKAGE_MANIFEST_FILE} ${i.path.join('.') || '(root)'}: ${i.message}`) }; }
  const problems = parsed.data.protocol === protocol ? [] : [`it speaks link protocol ${parsed.data.protocol}; this hub speaks ${protocol}`];
  return { manifest: parsed.data, problems };
}

/** What is wrong with one path inside a package (nothing when it is fine). */
export function pathProblems(path: string): string[] {
  return PackagePath.safeParse(path).success ? [] : [`${path} is not a path inside the package`];
}

/** Every file under a folder, as entries with forward-slash paths relative to it, in path order. */
export async function readTree(dir: string): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.isFile()) { out.push({ path: relative(dir, full).split(sep).join('/'), bytes: new Uint8Array(await readFile(full)) }); }
    }
  };
  await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Write entries under a folder, refusing any path that would land outside it. */
export async function writeTree(entries: readonly ZipEntry[], dir: string): Promise<void> {
  const root = resolve(dir);
  for (const entry of entries) {
    const target = resolve(root, entry.path);
    if (pathProblems(entry.path).length > 0 || !target.startsWith(`${root}${sep}`)) { throw new PackageError([`${entry.path} would land outside ${dir}`]); }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.bytes);
  }
}

/** JSON from bytes, or undefined when they aren't JSON (the schema then says what is wrong). */
export function parseJson(bytes: Uint8Array): unknown {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed;
  } catch {
    return undefined;
  }
}
