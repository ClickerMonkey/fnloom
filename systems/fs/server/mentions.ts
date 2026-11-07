/**
 * The `files` mention: `@` search over the roots' paths (from a short-lived index, so typing stays fast), the hover
 * card with a preview, and the text the LLM gets for a mentioned file.
 */
import type { MentionHover, UserInfo } from '@harness/core';
import type { MentionOption } from '@harness/sdk';
import { formatBytes, lastSegment } from '../shared/format.ts';
import type { FileTargetValue } from '../shared/index.ts';
import type { FileService } from './files.ts';
import type { Documents, EntryValue, Located, PathGuard, ResolvedRoot } from './index.ts';
import { childPath, fileUri, parentOf } from './paths.ts';
import { FsProblem } from './problem.ts';
import { collect, type WalkEntry } from './walk.ts';

/** How the path index is kept. */
export interface IndexLimits {
  /** How long a root's paths are reused before walking it again. */
  readonly ttl: number;
  /** Most paths kept per root. */
  readonly max: number;
  readonly ignore: readonly string[];
}

/** Every path under each root, walked at most once per `ttl`. */
export class PathIndex {
  private readonly cache = new Map<string, { at: number; entries: Promise<WalkEntry[]> }>();
  private readonly limits: IndexLimits;
  private readonly now: () => number;

  constructor(limits: IndexLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }

  paths(root: ResolvedRoot): Promise<WalkEntry[]> {
    const hit = this.cache.get(root.folder);
    if (hit !== undefined && this.now() - hit.at < this.limits.ttl) { return hit.entries; }
    const entries = collect(root.folder, { ignore: this.limits.ignore, limit: this.limits.max });
    this.cache.set(root.folder, { at: this.now(), entries });
    entries.catch(() => { this.cache.delete(root.folder); });
    return entries;
  }

  /** Forget everything, so the next search walks again (after files change). */
  clear(): void {
    this.cache.clear();
  }
}

/** How well a path matches a query: lower is better; `undefined` when it doesn't. */
export function score(query: string, entry: WalkEntry): number | undefined {
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  if (name === q) { return 0; }
  if (name.startsWith(q)) { return 1; }
  if (name.includes(q)) { return 2; }
  if (entry.relative.toLowerCase().includes(q)) { return 3; }
  return undefined;
}

/** The best matches for a query across roots, best first; with no query, each root's top level. */
export function rank(query: string, found: ReadonlyArray<{ root: ResolvedRoot; entry: WalkEntry }>, limit: number): Array<{ root: ResolvedRoot; entry: WalkEntry }> {
  const q = query.trim();
  if (q === '') { return found.filter((item) => item.entry.depth === 1).slice(0, limit); }
  return found
    .flatMap((item) => { const s = score(q, item.entry); return s === undefined ? [] : [{ ...item, s }]; })
    .sort((a, b) => a.s - b.s || a.entry.relative.length - b.entry.relative.length || a.entry.relative.localeCompare(b.entry.relative))
    .slice(0, limit)
    .map(({ root, entry }) => ({ root, entry }));
}

/** How mention results and cards are made. */
export interface MentionLimits {
  /** Most results per search. */
  readonly results: number;
  /** Lines a hover card previews. */
  readonly previewLines: number;
}

/** The files mention's behaviour, over whatever roots a request's config names. */
export class FileMentions {
  private readonly index: PathIndex;
  private readonly files: FileService;
  private readonly documents: Documents;
  private readonly limits: MentionLimits;

  constructor(deps: { index: PathIndex; files: FileService; documents: Documents; limits: MentionLimits }) {
    this.index = deps.index;
    this.files = deps.files;
    this.documents = deps.documents;
    this.limits = deps.limits;
  }

  async search(guard: PathGuard, query: string): Promise<MentionOption<FileTargetValue>[]> {
    const found = (await Promise.all(guard.roots.map(async (root) => (await this.index.paths(root)).map((entry) => ({ root, entry }))))).flat();
    return rank(query, found, this.limits.results).map(({ root, entry }) => ({
      label: entry.type === 'folder' ? `${entry.name}/` : entry.name,
      hint: entry.depth === 1 ? root.name : `${root.name} · ${parentOf(entry.relative)}`,
      icon: entry.type === 'folder' ? 'folder' : 'file',
      target: { root: root.name, path: entry.relative },
    }));
  }

  async hover(guard: PathGuard, target: FileTargetValue, user: UserInfo): Promise<(Omit<MentionHover, 'value'> & { value?: EntryValue }) | undefined> {
    const at = this.locate(guard, target);
    const entry = at === undefined ? undefined : await this.files.entry(at.path);
    if (at === undefined || entry === undefined) { return undefined; }
    const modified = new Intl.DateTimeFormat(user.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: user.timeZone }).format(entry.modifiedAt);
    const fields = [
      { label: 'Type', value: entry.type === 'file' ? (this.documents.format(at.path) ?? 'file') : entry.type },
      ...(entry.type === 'file' ? [{ label: 'Size', value: formatBytes(entry.size) }] : []),
      { label: 'Modified', value: modified },
    ];
    const body = await this.preview(at, entry);
    return {
      title: lastSegment(at.path),
      subtitle: at.relative === '' ? at.root.folder : `${at.root.name}/${at.relative}`,
      fields,
      ...(body === undefined ? {} : { body }),
      open: { resource: fileUri(at.path) },
      value: entry,
    };
  }

  async llm(guard: PathGuard, target: FileTargetValue): Promise<string> {
    const at = this.locate(guard, target);
    const entry = at === undefined ? undefined : await this.files.entry(at.path);
    if (at === undefined || entry === undefined) { return `"${target.path}" in the root "${target.root}" no longer exists.`; }
    const where = `in the fs root "${at.root.name}"`;
    return entry.type === 'folder'
      ? `Folder ${at.path} ${where}. List it with fs/list { "path": "${at.path}" }.`
      : `File ${at.path} ${where} (${formatBytes(entry.size)}). Read it with fs/read { "path": "${at.path}" }.`;
  }

  private locate(guard: PathGuard, target: FileTargetValue): Located | undefined {
    const root = guard.root(target.root);
    if (root === undefined) { return undefined; }
    try {
      return guard.resolve(target.path === '' ? root.folder : childPath(root.folder, target.path), { write: false });
    } catch (error) {
      if (error instanceof FsProblem) { return undefined; }
      throw error;
    }
  }

  private async preview(at: Located, entry: EntryValue): Promise<string | undefined> {
    if (entry.type !== 'file' || this.limits.previewLines === 0) { return undefined; }
    try {
      const slice = await this.files.read(at, 0, this.limits.previewLines);
      const language = this.documents.format(at.path) ?? '';
      return `\`\`\`${language}\n${slice.text}${slice.truncated ? '\n…' : ''}\n\`\`\``;
    } catch (error) {
      if (error instanceof FsProblem) { return undefined; }
      throw error;
    }
  }
}
