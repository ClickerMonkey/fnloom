/**
 * A scratch folder for tests of fns that touch files or run commands (and report what changed, `ChangeSet`, or which
 * files are sensitive, `SensitivityFlag`): files written in, optionally a git repository with everything committed,
 * so a test sets up "clean", "changed before the call", "untracked" and "ignored" files in a few lines.
 *
 * ```ts
 * const repo = await scratchFolder({ git: true, files: { 'a.txt': 'one\n', '.gitignore': 'dist/\n' } });
 * repo.write('a.txt', 'two\n');            // changed since the commit
 * expect(repo.git('status', '--porcelain')).toContain('a.txt');
 * await repo.dispose();
 * ```
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** What `scratchFolder` sets up. */
export interface ScratchOptions {
  /** Files by path from the folder (`src/a.ts`), with their text. */
  readonly files?: Readonly<Record<string, string>>;
  /** Make it a git repository and commit the files. */
  readonly git?: boolean;
}

/** A scratch folder: its path, file helpers, git, and removal. */
export interface ScratchFolder {
  readonly dir: string;
  /** Write a file (folders made as needed). */
  write(path: string, text: string | Uint8Array): void;
  read(path: string): string;
  remove(path: string): void;
  /** Run git in the folder; its output. Throws when git fails. */
  git(...args: string[]): string;
  /** Remove the folder. */
  dispose(): Promise<void>;
}

/** A fresh folder under the system's temp folder, with the files given, committed when `git` is set. */
export function scratchFolder(options: ScratchOptions = {}): Promise<ScratchFolder> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-scratch-'));
  const at = (path: string): string => join(dir, path);
  const folder: ScratchFolder = {
    dir,
    write: (path, text) => { mkdirSync(dirname(at(path)), { recursive: true }); writeFileSync(at(path), text); },
    read: (path) => readFileSync(at(path), 'utf8'),
    remove: (path) => { rmSync(at(path), { force: true, recursive: true }); },
    git: (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }),
    dispose: () => { rmSync(dir, { recursive: true, force: true }); return Promise.resolve(); },
  };
  for (const [path, text] of Object.entries(options.files ?? {})) { folder.write(path, text); }
  if (options.git === true) {
    folder.git('init', '--quiet', '--initial-branch=main');
    folder.git('add', '--all');
    folder.git('commit', '--quiet', '--allow-empty', '--message', 'scratch');
  }
  return Promise.resolve(folder);
}
