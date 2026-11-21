/**
 * What the bash card's "Changes" strip shows, worked out from a command's change set so the component only draws: a
 * tab per file with a diff, and the files listed without one, each with why. Pure and browser-safe.
 */
import type { ChangeSet, FileChange, FileChangeStatus, NoDiffReason, SensitivityKind } from '@harness/core';
import { blockStats, patchBlocks, type DiffBlock } from './diff.ts';

/** A changed file with a diff, as a tab. */
export interface ChangeTab {
  readonly key: string;
  readonly file: FileChange;
  /** The tab's label: the file name, with its folder when two tabs would read the same. */
  readonly name: string;
  readonly blocks: readonly DiffBlock[];
  readonly added: number;
  readonly removed: number;
}

/** A changed file listed without a diff, and why. */
export interface UndiffedFile {
  readonly key: string;
  readonly file: FileChange;
  readonly why: string;
}

/** How a change reads on its tab and row. */
export const STATUS_WORDS: Readonly<Record<FileChangeStatus, string>> = { added: 'Added', modified: 'Changed', deleted: 'Deleted', renamed: 'Renamed' };

/** What kind of sensitive file it is, in plain words. */
const SENSITIVE_WORDS: Readonly<Record<SensitivityKind, string>> = {
  gitignored: 'ignored by git', env: 'an env file', key: 'a key', credential: 'a credential file', token: 'holds a token', 'secret-content': 'holds a password',
  'runs-code': 'runs code', 'unknown-path': 'a path not known',
};

/** Why a file has no diff, in plain words. */
const NO_DIFF_WORDS: Readonly<Record<Exclude<NoDiffReason, 'sensitive'>, string>> = {
  binary: 'Binary file', large: 'Too large to show', 'not-in-git': 'Not in git, so not diffed',
};

/** The key of a file in a change set. */
function keyOf(file: FileChange): string {
  return `${file.root}:${file.path}`;
}

/** A path's last segment. */
function nameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Why a changed file has no diff. */
export function whyNoDiff(file: FileChange): string {
  if (file.noDiff === 'sensitive' || file.sensitive !== undefined) {
    return `Sensitive (${file.sensitive === undefined ? 'flagged by a rule' : SENSITIVE_WORDS[file.sensitive]}), so not shown`;
  }
  return file.noDiff === undefined ? 'No diff' : NO_DIFF_WORDS[file.noDiff];
}

/** The tabs: each file with a diff, labelled by name (with the folder when names repeat). */
export function changeTabs(set: ChangeSet): ChangeTab[] {
  const diffed = set.files.filter((file): file is FileChange & { diff: string } => file.diff !== undefined);
  const counts = new Map<string, number>();
  for (const file of diffed) { counts.set(nameOf(file.path), (counts.get(nameOf(file.path)) ?? 0) + 1); }
  return diffed.map((file) => {
    const blocks = patchBlocks(file.diff);
    const stats = file.added !== undefined && file.removed !== undefined ? { added: file.added, removed: file.removed } : blockStats(blocks);
    const name = (counts.get(nameOf(file.path)) ?? 0) > 1 ? file.path.split('/').slice(-2).join('/') : nameOf(file.path);
    return { key: keyOf(file), file, name, blocks, ...stats };
  });
}

/** The files without a diff, each with why. */
export function undiffed(set: ChangeSet): UndiffedFile[] {
  return set.files.filter((file) => file.diff === undefined).map((file) => ({ key: keyOf(file), file, why: whyNoDiff(file) }));
}

/** The strip's heading line: how many files changed, how many more git ignores, and whether the list is cut. */
export function changesSummary(set: ChangeSet): string {
  const files = set.files.length;
  const parts = [`${files}${set.truncated ? '+' : ''} ${files === 1 && !set.truncated ? 'file' : 'files'} changed`];
  if (set.ignored > 0) { parts.push(`${set.ignored} more ignored by git`); }
  return parts.join(' · ');
}

/** Whether some changes may be another call's (one ran in the same folder at the same time). */
export function uncertain(set: ChangeSet): boolean {
  return set.files.some((file) => !file.certain);
}
