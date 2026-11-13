/**
 * Sensitive files on an approval card, in plain words: what the call does to each file ("Writes", "May read" when the
 * system only found the path in a command line), what kind of file it is and why it is guarded. A call that touches
 * one is asked about every time; the answer is never remembered.
 */
import type { SensitivityFlag, SensitivityKind } from '@harness/core';

/** What kind of file each sensitivity kind is, as the card says it. */
export const SENSITIVE_KIND_WORDS = {
  gitignored: 'Ignored by git',
  env: 'Environment file',
  key: 'Key file',
  credential: 'Credentials',
  token: 'Token',
  'secret-content': 'Holds a secret',
} as const satisfies Record<SensitivityKind, string>;

/** One flagged file, ready to show. */
export interface FlagRow {
  readonly key: string;
  readonly path: string;
  /** "Reads", "Writes", "May read", "May write". */
  readonly verb: string;
  readonly kind: string;
  readonly why: string;
  readonly write: boolean;
}

/** The flags as rows: writes first, then by path; one row per file and access. */
export function flagRows(flags: readonly SensitivityFlag[]): FlagRow[] {
  const rows = new Map<string, FlagRow>();
  for (const flag of flags) {
    const write = flag.access === 'write';
    const key = `${flag.access}:${flag.path}`;
    if (rows.has(key)) { continue; }
    const verb = flag.certain ? (write ? 'Writes' : 'Reads') : (write ? 'May write' : 'May read');
    rows.set(key, { key, path: flag.path, verb, kind: SENSITIVE_KIND_WORDS[flag.kind], why: flag.why, write });
  }
  return [...rows.values()].sort((a, b) => Number(b.write) - Number(a.write) || a.path.localeCompare(b.path));
}

/** The heading over the rows: how many files, and that it is asked about every time. */
export function flagsHeading(rows: readonly FlagRow[]): string {
  const files = new Set(rows.map((row) => row.path)).size;
  return files === 1 ? 'It touches a sensitive file' : `It touches ${String(files)} sensitive files`;
}
