/**
 * Documents: files of many formats read as text with their links, through `@aeye/resources` (markdown, html, code,
 * pdf, docx and more). Relative links are resolved against the file's folder so they become `file://` URIs; a
 * relative import in a script (`./foo`, `./foo.js` for `foo.ts`, `./dir` for `dir/index.ts`) is resolved the way
 * node and TypeScript resolve it, against the files that are really there. A file the registry can't parse is read
 * as plain text only when its bytes are text.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CODE_TYPES, type ResourceRegistry } from '@aeye/resources';
import { ResourceUri, type ResourceLink } from '@harness/core';
import type { Document, Documents } from './index.ts';
import { fileUri, normalize, parentOf } from './paths.ts';

/** Formats whose links are imports rather than references. */
const CODE_FORMATS: ReadonlySet<string> = new Set(CODE_TYPES);

/** Formats whose relative imports follow node and TypeScript module resolution. */
const SCRIPT_FORMATS: ReadonlySet<string> = new Set(['javascript', 'typescript', 'jsx', 'tsx']);

/** Extensions a script import may leave off, in the order TypeScript tries them. */
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const;

/** What an ESM import's written extension may stand for in TypeScript source (`./a.js` names `a.ts`). */
const SOURCE_FOR: Readonly<Record<string, readonly string[]>> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** Formats that are never text, so a failed parse isn't read as text either. */
const BINARY_FORMATS: ReadonlySet<string> = new Set(['pdf', 'image', 'excel', 'docx', 'zip']);

/** How many leading bytes are checked for a NUL byte, the sign of a binary file. */
const SNIFF_BYTES = 8_000;

/** A link as the parser found it. */
export interface FoundLink {
  readonly value: string;
  readonly kind: 'resource' | 'external';
  readonly title?: string | undefined;
}

/** Whether a path names a file (not a folder, not nothing). */
export type IsFile = (path: string) => Promise<boolean>;

/** The absolute path a relative link names (its fragment dropped), or `undefined` for a URL, a package or an anchor. */
export function linkPath(found: FoundLink, from: string): string | undefined {
  if (found.kind === 'external') { return undefined; }
  const target = found.value.split('#')[0] ?? '';
  return target !== '' && (target.startsWith('.') || target.startsWith('/')) ? normalize(join(parentOf(from), target)) : undefined;
}

/** The files a relative script import may mean, most likely first: as written, its source file, with an extension, then a folder's index. */
export function importCandidates(path: string): string[] {
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  return [
    path,
    ...(SOURCE_FOR[ext] ?? []).map((source) => `${stem}${source}`),
    ...SCRIPT_EXTENSIONS.map((extension) => `${path}${extension}`),
    ...SCRIPT_EXTENSIONS.map((extension) => `${path}/index${extension}`),
  ];
}

/** The link as a resource link: URLs kept, `path` (the file it names, already resolved) as a `file://` URI, the rest raw. */
export function toResourceLink(found: FoundLink, format: string | undefined, path: string | undefined): ResourceLink {
  const title = found.title === undefined ? {} : { title: found.title };
  if (found.kind === 'external') {
    const uri = ResourceUri.safeParse(found.value);
    return { raw: found.value, kind: 'external', ...(uri.success ? { uri: uri.data } : {}), ...title };
  }
  const kind = format !== undefined && CODE_FORMATS.has(format) ? 'import' : 'link';
  return { raw: found.value, kind, ...(path === undefined ? {} : { uri: fileUri(path) }), ...title };
}

/** The bytes as text, or `undefined` when they look binary (a NUL byte near the start) or aren't UTF-8. */
export function plainText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) { return undefined; }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Whether a path is a file, on the real filesystem. */
export const diskIsFile: IsFile = async (path) => (await stat(path).catch(() => undefined))?.isFile() === true;

/** Documents through an aeye resource registry. */
export class AeyeDocuments implements Documents {
  private readonly registry: ResourceRegistry;
  private readonly isFile: IsFile;

  constructor(registry: ResourceRegistry, isFile: IsFile = diskIsFile) {
    this.registry = registry;
    this.isFile = isFile;
  }

  format(path: string): string | undefined {
    return this.registry.inferType(path);
  }

  async read(path: string, signal?: AbortSignal): Promise<Document> {
    const format = this.format(path);
    try {
      const { resource } = await this.registry.parse(path, signal === undefined ? {} : { signal });
      const text = resource.parts.flatMap((part) => (part.kind === 'text' && part.text !== undefined ? [part.text] : [])).join('\n\n');
      const seen = new Set<string>();
      const found = resource.links.filter((link) => !seen.has(link.value) && seen.add(link.value));
      const links = await Promise.all(found.map(async (link) => toResourceLink(link, resource.type, await this.target(link, path, resource.type))));
      return { format: resource.type, text, links };
    } catch (error) {
      signal?.throwIfAborted();
      // a format the registry can't parse is still readable as plain text, when it is text
      const text = format !== undefined && BINARY_FORMATS.has(format) ? undefined : plainText(await readFile(path));
      if (text === undefined) { throw error; }
      return { format, text, links: [] };
    }
  }

  /** The file a link names: a script's relative import resolved against what exists (none when nothing matches). */
  private async target(found: FoundLink, from: string, format: string): Promise<string | undefined> {
    const path = linkPath(found, from);
    if (path === undefined || !SCRIPT_FORMATS.has(format)) { return path; }
    for (const candidate of importCandidates(path)) {
      if (await this.isFile(candidate)) { return candidate; }
    }
    return undefined;
  }
}
