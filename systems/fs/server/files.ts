/**
 * File operations behind the fns: reading text, writing, exact-text edits, removing, listing, and putting a file
 * back for undo. Paths arrive already resolved by the guard; problems a caller can fix are thrown as `FsProblem`.
 */
import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { ContentRef, UndoOutcome } from '@harness/core';
import { lineCount } from '../shared/format.ts';
import type { PreviousValue } from '../shared/index.ts';
import type { EntryValue, Located, PathGuard, Snapshots } from './index.ts';
import { parentOf } from './paths.ts';
import { FsProblem, isErrno } from './problem.ts';
import { collect } from './walk.ts';

/** Where an operation works: only the resolved path matters. */
type At = Pick<Located, 'path'>;

/** The limits file operations keep to. */
export interface FileLimits {
  /** Lines `read` returns when no limit is given. */
  readonly readLines: number;
  /** Largest file opened as text, in bytes. */
  readonly fileMax: number;
  /** Most entries a listing returns. */
  readonly listLimit: number;
  /** Folder names listings skip. */
  readonly ignore: readonly string[];
}

/** A slice of a text file by line. */
export interface TextSlice {
  readonly text: string;
  /** Lines in the whole file. */
  readonly lines: number;
  readonly truncated: boolean;
}

/** A change to a file: its text before and after (for the diff), and the snapshot that undoes it. */
export interface FileChange {
  readonly before: string;
  readonly after: string;
  readonly previous: ContentRef | null;
}

/** How many bytes are checked for NUL to tell binary from text. */
const SNIFF = 8_000;
const TEXT_MIME = 'text/plain; charset=utf-8';
const BINARY_MIME = 'application/octet-stream';

/** How many times `find` occurs in `text`, without overlaps. */
export function occurrences(text: string, find: string): number {
  return find === '' ? 0 : text.split(find).length - 1;
}

/** Replace exact text: every occurrence, or the first. No `$` patterns, unlike `String.replace`. */
export function replaceText(text: string, find: string, replace: string, all: boolean): string {
  if (all) { return text.split(find).join(replace); }
  const at = text.indexOf(find);
  return at < 0 ? text : `${text.slice(0, at)}${replace}${text.slice(at + find.length)}`;
}

/** The entry at a path through `lstat` (links as links) or `stat` (links followed). */
async function entryAt(path: string, look: typeof lstat): Promise<EntryValue | undefined> {
  try {
    const found = await look(path);
    const type = found.isSymbolicLink() ? 'link' : found.isDirectory() ? 'folder' : 'file';
    return { path, type, size: type === 'file' ? found.size : 0, modifiedAt: found.mtime };
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) { return undefined; }
    throw error;
  }
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, SNIFF).includes(0);
}

/** File operations over resolved paths. */
export class FileService {
  private readonly snapshots: Snapshots;
  private readonly limits: FileLimits;

  constructor(snapshots: Snapshots, limits: FileLimits) {
    this.snapshots = snapshots;
    this.limits = limits;
  }

  /** What a path is now, or `undefined` when nothing is there. A link is reported as a link. */
  entry(path: string): Promise<EntryValue | undefined> {
    return entryAt(path, lstat);
  }

  /**
   * What a path leads to, following links: a file or a folder, or `undefined` when nothing (or a broken link) is
   * there. Callers check with the guard first that a link stays inside the roots.
   */
  target(path: string): Promise<EntryValue | undefined> {
    return entryAt(path, stat);
  }

  /** A file's text, refusing folders, binary files and files over the size limit. */
  async text(at: At): Promise<string> {
    const bytes = await this.bytes(at);
    if (isBinary(bytes)) { throw new FsProblem('binary', `${at.path} is a binary file, not text.`); }
    return new TextDecoder().decode(bytes);
  }

  /** Lines `offset` (0-based) onwards, at most `limit` of them. */
  async read(at: At, offset = 0, limit = this.limits.readLines): Promise<TextSlice> {
    const text = await this.text(at);
    const lines = lineCount(text);
    const all = text.split('\n');
    const end = Math.min(offset + limit, lines);
    const slice = all.slice(offset, end).join('\n');
    return { text: slice, lines, truncated: offset > 0 || end < lines };
  }

  /** Write a file, making its folder if needed. */
  async write(at: At, text: string): Promise<FileChange & { created: boolean }> {
    const existing = await this.target(at.path);
    if (existing !== undefined && existing.type !== 'file') { throw new FsProblem('not-a-file', `${at.path} is a ${existing.type}, not a file.`); }
    const kept = existing === undefined ? undefined : await this.keep(at);
    await mkdir(parentOf(at.path), { recursive: true });
    await writeFile(at.path, text);
    return { created: existing === undefined, before: kept?.text ?? '', after: text, previous: kept?.ref ?? null };
  }

  /** Replace exact text. Refuses text that isn't there, or is there more than once without `all`. */
  async edit(at: At, find: string, replace: string, all: boolean): Promise<FileChange & { replacements: number }> {
    const before = await this.text(at);
    const count = occurrences(before, find);
    if (count === 0) {
      const hint = occurrences(before, find.trim()) > 0 ? ' It is there without its leading or trailing whitespace.' : ' Read the file and copy the text exactly.';
      throw new FsProblem('no-match', `The text to replace isn't in ${at.path}.${hint}`);
    }
    if (count > 1 && !all) {
      throw new FsProblem('ambiguous', `The text to replace appears ${count} times in ${at.path}. Add surrounding lines so it is unique, or pass all: true.`);
    }
    const after = replaceText(before, find, replace, all);
    const ref = await this.snapshots.save(new TextEncoder().encode(before), TEXT_MIME);
    await writeFile(at.path, after);
    return { before, after, previous: ref, replacements: all ? count : 1 };
  }

  /** Delete a file, keeping a snapshot for undo. */
  async remove(at: At): Promise<FileChange> {
    const kept = await this.keep(at);
    await rm(at.path);
    return { before: kept.text ?? '', after: '', previous: kept.ref };
  }

  /** A folder's entries, `depth` levels down. */
  async list(at: At, depth: number): Promise<EntryValue[]> {
    const self = await this.target(at.path);
    if (self === undefined) { throw new FsProblem('not-found', `${at.path} doesn't exist.`); }
    if (self.type !== 'folder') { throw new FsProblem('not-a-folder', `${at.path} is a ${self.type}, not a folder.`); }
    const found = await collect(at.path, { ignore: this.limits.ignore, depth, limit: this.limits.listLimit });
    const entries = await Promise.all(found.map((item) => this.entry(item.path)));
    return entries.filter((entry) => entry !== undefined);
  }

  /** Put a file back as it was before a change: its snapshot, or nothing if it didn't exist. */
  async restore(payload: PreviousValue, guard: PathGuard): Promise<UndoOutcome> {
    let at: Located;
    try {
      at = guard.resolve(payload.path, { write: true });
    } catch (error) {
      if (error instanceof FsProblem) { return { status: 'failed', error: { class: 'caller', message: error.message, code: error.code } }; }
      throw error;
    }
    if (payload.previous === null) {
      await rm(at.path, { force: true });
      return { status: 'undone', summary: `Removed ${at.path}, which didn't exist before.` };
    }
    const bytes = await this.snapshots.load(payload.previous);
    if (bytes === undefined) { return { status: 'gone' }; }
    await mkdir(parentOf(at.path), { recursive: true });
    await writeFile(at.path, bytes);
    return { status: 'undone', summary: `Restored ${at.path}.` };
  }

  private async bytes(at: At): Promise<Uint8Array> {
    const self = await this.target(at.path);
    if (self === undefined) { throw new FsProblem('not-found', `${at.path} doesn't exist.`); }
    if (self.type === 'folder') { throw new FsProblem('not-a-file', `${at.path} is a folder. List it with fs/list.`); }
    if (self.size > this.limits.fileMax) { throw new FsProblem('too-large', `${at.path} is ${self.size} bytes, over the ${this.limits.fileMax} byte limit.`); }
    return readFile(at.path);
  }

  /** Snapshot a file that exists, with its text when it is text. */
  private async keep(at: At): Promise<{ ref: ContentRef; text: string | undefined }> {
    const bytes = await this.bytes(at);
    const binary = isBinary(bytes);
    const ref = await this.snapshots.save(bytes, binary ? BINARY_MIME : TEXT_MIME);
    return { ref, text: binary ? undefined : new TextDecoder().decode(bytes) };
  }
}
