/**
 * A system's resources as MCP resources. The listing is the system's roots, then each root's direct children, page
 * by page; each root is also a URI template (`<root>/{+path}`), so a client can read anything under it. A read gives
 * the resource's text (converted text, such as markdown for documents) or, failing that, its bytes; a resource with
 * neither reads as no contents. When the system can watch resources, clients can subscribe to a URI and hear when it
 * (or anything under it) changes.
 */
import type { McpResource, McpResourceContents, McpResourcePage, McpResourceSource, McpResourceTemplate } from '@ayepi/mcp';
import { ResourceUri, type ResourceRoot, type ResourceStat } from '@harness/core';
import { z } from 'zod';
import type { ProvidedRead, ResourceProvider } from '../resources.ts';
import type { ContentTransfer } from './content.ts';

/** Where a listing is up to: which root's children, and the cursor within them. */
const ListCursor = z.object({ root: z.number().int().min(0), cursor: z.string().optional() });
type ListCursor = z.infer<typeof ListCursor>;

/** The MIME type MCP clients know a folder by. */
const FOLDER_MIME = 'inode/directory';

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(cursor: string): ListCursor {
  try {
    return ListCursor.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new Error(`"${cursor}" is not a cursor this server gave.`);
  }
}

/** A URI without its trailing slashes, so `x://a/` and `x://a` name the same place. */
function withoutSlash(uri: string): string {
  return uri.replace(/\/+$/, '');
}

/** A root as a listed resource. */
function rootResource(root: ResourceRoot): McpResource {
  return { uri: root.uri, name: root.name, description: root.description, mimeType: FOLDER_MIME };
}

/** A resource stat as a listed resource. */
function statResource(stat: ResourceStat): McpResource {
  const mime = stat.type === 'folder' ? FOLDER_MIME : stat.mime;
  return { uri: stat.uri, name: stat.name, ...(mime === undefined ? {} : { mimeType: mime }), ...(stat.size === undefined ? {} : { size: stat.size }) };
}

/** The MIME type of a read's text: the resource's own when it is text, else markdown (what documents convert to). */
function textMime(stat: ResourceStat): string {
  return stat.mime?.startsWith('text/') === true ? stat.mime : 'text/markdown';
}

/** A system's resource provider as an MCP resource source. */
export class McpResources implements McpResourceSource {
  readonly #provider: ResourceProvider;
  readonly #content: ContentTransfer;

  constructor(provider: ResourceProvider, content: ContentTransfer) {
    this.#provider = provider;
    this.#content = content;
  }

  /** The source for a provider: one that can be subscribed to when the provider can watch. */
  static of(provider: ResourceProvider, content: ContentTransfer): McpResources {
    return provider.watch === undefined ? new McpResources(provider, content) : new WatchedMcpResources(provider, content, provider.watch.bind(provider));
  }

  async list(cursor: string | undefined): Promise<McpResourcePage> {
    const roots = await this.#provider.roots();
    const at: ListCursor = cursor === undefined ? { root: 0 } : decodeCursor(cursor);
    const head = cursor === undefined ? roots.map(rootResource) : [];
    const root = roots[at.root];
    if (root === undefined) { return { resources: head }; }
    const page = await this.#provider.list(root.uri, at.cursor);
    const next: ListCursor | undefined = page.cursor !== undefined ? { root: at.root, cursor: page.cursor } : at.root + 1 < roots.length ? { root: at.root + 1 } : undefined;
    return { resources: [...head, ...page.items.map(statResource)], ...(next === undefined ? {} : { nextCursor: encodeCursor(next) }) };
  }

  async templates(): Promise<McpResourceTemplate[]> {
    return (await this.#provider.roots()).map((root) => ({
      uriTemplate: `${withoutSlash(root.uri)}/{+path}`,
      name: root.name,
      description: `${root.description} Any path under ${root.name}.`,
    }));
  }

  async read(uri: string, signal: AbortSignal): Promise<McpResourceContents[] | undefined> {
    const parsed = ResourceUri.safeParse(uri);
    if (!parsed.success) { return undefined; }
    const stat = await this.#provider.stat(parsed.data);
    if (stat === undefined) { return undefined; }
    return this.#contents(await this.#provider.read(parsed.data, ['text', 'bytes']), signal);
  }

  async #contents(read: ProvidedRead, signal: AbortSignal): Promise<McpResourceContents[]> {
    const { stat, text, bytes } = read;
    if (text !== undefined) {
      const inline = 'inline' in text ? text.inline : new TextDecoder().decode(await this.#content.download(text.ref, signal));
      return [{ uri: stat.uri, mimeType: textMime(stat), text: inline }];
    }
    if (bytes !== undefined) {
      const data = 'data' in bytes ? bytes.data : await this.#content.download(bytes, signal);
      return [{ uri: stat.uri, mimeType: bytes.mime, blob: Buffer.from(data).toString('base64') }];
    }
    return [];
  }
}

/** The provider's watch. */
type Watch = NonNullable<ResourceProvider['watch']>;

/** Resources a client can subscribe to: an update is any change at the URI or under it. */
class WatchedMcpResources extends McpResources {
  readonly #watch: Watch;

  constructor(provider: ResourceProvider, content: ContentTransfer, watch: Watch) {
    super(provider, content);
    this.#watch = watch;
  }

  watch(uri: string, onUpdate: () => void): () => void {
    const parsed = ResourceUri.safeParse(uri);
    if (!parsed.success) { return () => undefined; }
    const base = withoutSlash(parsed.data);
    return this.#watch([parsed.data], (changes) => {
      if (changes.some((change) => withoutSlash(change.uri) === base || change.uri.startsWith(`${base}/`))) { onUpdate(); }
    });
  }
}
