/**
 * Documents: files of many formats read as text with their links, through `@aeye/resources` (markdown, html, code,
 * pdf, docx and more). Relative links are resolved against the file's folder so they become `file://` URIs.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResourceRegistry } from '@aeye/resources';
import { ResourceUri, type ResourceLink } from '@harness/core';
import type { Document, Documents } from './index.ts';
import { fileUri, normalize, parentOf } from './paths.ts';

/** Formats whose links are imports rather than references. */
const CODE_FORMATS = new Set(['typescript', 'javascript', 'tsx', 'jsx', 'python', 'go', 'rust', 'java', 'csharp', 'c', 'cpp', 'ruby', 'php', 'vue', 'svelte', 'kotlin', 'swift']);

/** A link as the parser found it. */
export interface FoundLink {
  readonly value: string;
  readonly kind: 'resource' | 'external';
  readonly title?: string | undefined;
}

/** The link as a resource link: relative paths resolved against `from`'s folder, URLs kept, bare packages left raw. */
export function toResourceLink(found: FoundLink, from: string, format: string | undefined): ResourceLink {
  const title = found.title === undefined ? {} : { title: found.title };
  if (found.kind === 'external') {
    const uri = ResourceUri.safeParse(found.value);
    return { raw: found.value, kind: 'external', ...(uri.success ? { uri: uri.data } : {}), ...title };
  }
  const kind = format !== undefined && CODE_FORMATS.has(format) ? 'import' : 'link';
  const target = found.value.split('#')[0] ?? '';
  const relative = target.startsWith('.') || target.startsWith('/');
  return relative && target !== ''
    ? { raw: found.value, kind, uri: fileUri(normalize(join(parentOf(from), target))), ...title }
    : { raw: found.value, kind, ...title };
}

/** Documents through an aeye resource registry. */
export class AeyeDocuments implements Documents {
  private readonly registry: ResourceRegistry;
  constructor(registry: ResourceRegistry) {
    this.registry = registry;
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
      const links = resource.links.filter((link) => !seen.has(link.value) && seen.add(link.value)).map((link) => toResourceLink(link, path, resource.type));
      return { format: resource.type, text, links };
    } catch (error) {
      signal?.throwIfAborted();
      // a format the registry can't parse is still readable as plain text
      if (error instanceof Error) { return { format, text: await readFile(path, 'utf8'), links: [] }; }
      throw error;
    }
  }
}
