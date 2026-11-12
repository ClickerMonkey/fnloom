/**
 * What a command changed (build 8). fs records which files each `bash` call changed and returns them with its result:
 *
 * - **Inside git**, from `git status` taken before and after the call, and `git diff` (`--no-index` against a kept
 *   copy for a file that was already changed before the call).
 * - **Outside git**, from a file watcher started with the call: files are listed, not diffed.
 *
 * A change is tied to the call only when it happened during the call, in the call's working tree; when another call
 * ran in the same tree at the same time, the file is listed with `certain: false`. Gitignored files are counted, not
 * listed. Binary, large and sensitive files are listed without a diff, saying why. The run view shows a tab per changed
 * text file with its diff.
 */
import { z } from 'zod';
import { SensitivityKind } from './sensitivity.ts';

/** How a file changed. */
export const FILE_CHANGE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export const FileChangeStatus = z.enum(FILE_CHANGE_STATUSES);
export type FileChangeStatus = z.infer<typeof FileChangeStatus>;

/** Why a changed file has no diff. */
export const NO_DIFF_REASONS = ['binary', 'large', 'sensitive', 'not-in-git'] as const;
export const NoDiffReason = z.enum(NO_DIFF_REASONS);
export type NoDiffReason = z.infer<typeof NoDiffReason>;

/** One changed file. `diff` is a unified diff (git's), present for a text file in git that is small enough. */
export const FileChange = z.object({
  /** The path from the root, with `/`. */
  path: z.string().min(1),
  /** The root's name. */
  root: z.string().min(1),
  status: FileChangeStatus,
  /** The path it was renamed from. */
  from: z.string().min(1).optional(),
  /** Its size after the change (absent when deleted). */
  size: z.number().int().min(0).optional(),
  diff: z.string().optional(),
  /** Lines added and removed, when there is a diff. */
  added: z.number().int().min(0).optional(),
  removed: z.number().int().min(0).optional(),
  noDiff: NoDiffReason.optional(),
  /** Set when a sensitivity rule flags the file; such a file never carries a diff. */
  sensitive: SensitivityKind.optional(),
  /** False when another call ran in the same tree at the same time, so the change may be that call's. */
  certain: z.boolean(),
});
export type FileChange = z.infer<typeof FileChange>;

/** Everything a call changed. */
export const ChangeSet = z.object({
  /** How the changes were found. */
  source: z.enum(['git', 'watcher']),
  /** The working folder the call ran in. */
  cwd: z.string().min(1),
  files: z.array(FileChange),
  /** Changed files left out because git ignores them (build output, `node_modules`). */
  ignored: z.number().int().min(0),
  /** Whether more files changed than are listed (`files` is capped by the system's setting). */
  truncated: z.boolean(),
});
export type ChangeSet = z.infer<typeof ChangeSet>;
