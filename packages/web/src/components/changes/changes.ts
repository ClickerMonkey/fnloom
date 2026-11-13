/**
 * What a command changed (`ChangeSet`), as the run views show it: a tab per changed text file with its diff, and a
 * list of the files shown without one (binary, large, sensitive, outside git) saying why.
 */
import { ChangeSet, type FileChange, type FileChangeStatus, type Json, type NoDiffReason } from '@harness/core';
import { z } from 'zod';

/** A result that carries what its call changed (fs `bash`: `{ exitCode, stdout, stderr, changes }`). */
const WithChanges = z.object({ changes: ChangeSet });

/** The change set a run's result carries, if any. */
export function changeSetOf(result: Json | undefined): ChangeSet | undefined {
  const parsed = WithChanges.safeParse(result);
  return parsed.success ? parsed.data.changes : undefined;
}

/** Why a file has no diff, in plain words. */
export const NO_DIFF_WORDS = {
  binary: 'Binary file',
  large: 'Too large to show',
  sensitive: 'Sensitive: not shown',
  'not-in-git': 'Not in git: no diff',
} as const satisfies Record<NoDiffReason, string>;

/** How a file changed, as a short word. */
export const STATUS_WORDS = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
} as const satisfies Record<FileChangeStatus, string>;

/** A changed file, ready to show. */
export interface ChangeRow {
  /** Tells files apart across roots. */
  readonly key: string;
  /** The file's name, for its tab. */
  readonly name: string;
  readonly change: FileChange;
  /** Its diff, when it has one. */
  readonly diff: string | undefined;
  /** Why it has none ('' when it has one). */
  readonly why: string;
}

/** The last part of a path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The files as rows, in the order the system listed them. A tab's name is the file's, with its folder when two share it. */
export function changeRows(changes: ChangeSet): ChangeRow[] {
  const names = new Map<string, number>();
  for (const file of changes.files) { names.set(baseName(file.path), (names.get(baseName(file.path)) ?? 0) + 1); }
  return changes.files.map((change) => {
    const name = baseName(change.path);
    const diff = change.diff !== undefined && change.diff !== '' ? change.diff : undefined;
    const why = diff !== undefined ? '' : change.noDiff !== undefined ? NO_DIFF_WORDS[change.noDiff] : change.status === 'deleted' ? 'Deleted' : 'No diff';
    return { key: `${change.root}:${change.path}`, name: (names.get(name) ?? 0) > 1 ? change.path : name, change, diff, why };
  });
}

/** The line under the tabs: what else the set says (files git ignored, more than listed, changes that may be another call's). */
export function changesNote(changes: ChangeSet): string {
  const notes: string[] = [];
  if (changes.files.some((file) => !file.certain)) { notes.push('Files marked “maybe” changed while another call ran in the same folder.'); }
  if (changes.ignored > 0) { notes.push(`${String(changes.ignored)} ignored ${changes.ignored === 1 ? 'file' : 'files'} (build output and the like) not listed.`); }
  if (changes.truncated) { notes.push('More files changed than are listed.'); }
  return notes.join(' ');
}
