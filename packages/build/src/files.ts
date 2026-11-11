/**
 * The file system as a build sees it: read, write, list and copy, by absolute path. `NodeFiles` is the disk; the CLI's
 * `MemoryFiles` keeps everything in a map, so builds and commands are tested without one.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What a path is. */
export interface FileStat {
  readonly kind: 'file' | 'folder';
  /** When it last changed, in ms since the epoch. */
  readonly modified: number;
}

/** The files a build (and the CLI's commands) read and write. */
export interface BuildFiles {
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  /** Write a file, making its folder first. */
  write(path: string, bytes: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  /** Every file under a folder (absolute paths), skipping the named folders. */
  walk(folder: string, skip?: readonly string[]): Promise<string[]>;
  remove(path: string): Promise<void>;
  /** Copy a folder and everything in it. */
  copy(from: string, to: string): Promise<void>;
}

/** The disk. */
export class NodeFiles implements BuildFiles {
  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async write(path: string, bytes: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const found = await stat(path);
      return { kind: found.isDirectory() ? 'folder' : 'file', modified: found.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async walk(folder: string, skip: readonly string[] = []): Promise<string[]> {
    const out: string[] = [];
    const visit = async (at: string): Promise<void> => {
      for (const entry of await readdir(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) { if (!skip.includes(entry.name)) { await visit(full); } continue; }
        if (entry.isFile()) { out.push(full); }
      }
    };
    await visit(folder);
    return out.sort();
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async copy(from: string, to: string): Promise<void> {
    await cp(from, to, { recursive: true });
  }
}
