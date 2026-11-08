/**
 * A hub MCP's resources and prompts, over its live scope:
 *
 * - `HubMcpResources`: each exposed type as `harness://types/<system>/<Type>` (its definition as the TypeScript-like
 *   text the chat's static mode shows), each exposed context item with text as `harness://context/<system>/<name>`,
 *   and each exposed resource root; reading a root's resources goes through the hub's resource router, refused
 *   outside the scope.
 * - `HubMcpPrompts`: each exposed context item loadable by `/name` as a prompt of that name, filled with its text.
 *
 * Both re-read the scope on every list and read, so a narrowed MCP stops offering what it no longer exposes.
 */
import type { McpPrompt, McpPromptResult, McpPromptSource, McpResource, McpResourceContents, McpResourcePage, McpResourceSource } from '@ayepi/mcp';
import { QualifiedName, ResourceUri, splitName, type HubMcpId } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import { GinScopes } from '../catalog/scope.ts';
import { typeDefinition } from '../contextor/views.ts';
import type { ContentStore } from '../api/index.ts';
import type { ResourceRouter } from '../link/index.ts';
import type { McpScopes } from './index.ts';

/** The scheme of the hub's own views served as MCP resources. */
export const HARNESS_SCHEME = 'harness://';
const TYPES = `${HARNESS_SCHEME}types/`;
const CONTEXT = `${HARNESS_SCHEME}context/`;

/** The URI of a type's or context item's view: `harness://types/fs/Entry`. */
export function viewUri(kind: 'types' | 'context', name: QualifiedName): string {
  return `${kind === 'types' ? TYPES : CONTEXT}${name}`;
}

/** The qualified name a view URI names, if it is one of that kind. */
export function viewName(kind: 'types' | 'context', uri: string): QualifiedName | undefined {
  const prefix = kind === 'types' ? TYPES : CONTEXT;
  if (!uri.startsWith(prefix)) return undefined;
  const parsed = QualifiedName.safeParse(uri.slice(prefix.length));
  return parsed.success ? parsed.data : undefined;
}

/** What the sources read. */
export interface HubMcpSourcesDeps {
  readonly scopes: () => Pick<McpScopes, 'scope'>;
  readonly catalog: () => Pick<Catalog, 'type' | 'typeClosure' | 'context'>;
  readonly resources: () => Pick<ResourceRouter, 'roots' | 'read'>;
  readonly content: () => Pick<ContentStore, 'read'>;
}

/** One hub MCP's resources. */
export class HubMcpResources implements McpResourceSource {
  readonly #mcp: HubMcpId;
  readonly #deps: HubMcpSourcesDeps;
  readonly #gin = new GinScopes();

  constructor(mcp: HubMcpId, deps: HubMcpSourcesDeps) {
    this.#mcp = mcp;
    this.#deps = deps;
  }

  async list(): Promise<McpResourcePage> {
    const scope = await this.#deps.scopes().scope(this.#mcp);
    const types = [...scope.types].sort().map((name): McpResource => ({ uri: viewUri('types', name), name, mimeType: 'text/x-typescript', description: `The type ${name}.` }));
    const context: McpResource[] = [];
    for (const name of [...scope.context].sort()) {
      const record = await this.#deps.catalog().context(name);
      if (record?.decl.content !== undefined) context.push({ uri: viewUri('context', name), name, mimeType: 'text/markdown', description: record.decl.description });
    }
    const roots = this.#deps.resources().roots().filter((r) => scope.allowsResource(r.root.uri))
      .map((r): McpResource => ({ uri: r.root.uri, name: r.root.name, description: r.root.description }));
    return { resources: [...types, ...context, ...roots] };
  }

  async read(uri: string, signal: AbortSignal): Promise<readonly McpResourceContents[] | undefined> {
    const scope = await this.#deps.scopes().scope(this.#mcp);
    const type = viewName('types', uri);
    if (type !== undefined) return scope.types.has(type) ? this.#type(uri, type) : undefined;
    const item = viewName('context', uri);
    if (item !== undefined) {
      if (!scope.context.has(item)) return undefined;
      const text = (await this.#deps.catalog().context(item))?.decl.content;
      return text === undefined ? undefined : [{ uri, mimeType: 'text/markdown', text }];
    }
    const parsed = ResourceUri.safeParse(uri);
    if (!parsed.success || !scope.allowsResource(uri)) return undefined;
    const read = await this.#deps.resources().read(parsed.data, ['text'], signal);
    if (read.text === undefined) return [{ uri, mimeType: read.stat.mime, text: '' }];
    const text = 'inline' in read.text ? read.text.inline : new TextDecoder().decode(await this.#deps.content().read(read.text.ref, 0, read.text.ref.size));
    return [{ uri, mimeType: read.stat.mime, text }];
  }

  /** A type's definition, with the types it uses before it. */
  async #type(uri: string, name: QualifiedName): Promise<readonly McpResourceContents[] | undefined> {
    const catalog = this.#deps.catalog();
    const closure = await catalog.typeClosure([name]);
    const records = new Map<string, NonNullable<Awaited<ReturnType<Catalog['type']>>>>();
    for (const each of closure.order) {
      const record = await catalog.type(each);
      if (record !== undefined) records.set(each, record);
    }
    const lookup = (n: string) => records.get(n)?.def;
    const lines: string[] = [];
    for (const record of records.values()) {
      lines.push(typeDefinition(record.name, record, this.#gin.one(record.def, lookup).type.toCode()));
    }
    return records.has(name) ? [{ uri, mimeType: 'text/x-typescript', text: lines.join('\n\n') }] : undefined;
  }
}

/** One hub MCP's prompts: exposed context loadable by `/name`. */
export class HubMcpPrompts implements McpPromptSource {
  readonly #mcp: HubMcpId;
  readonly #deps: HubMcpSourcesDeps;
  #listed: readonly McpPrompt[] = [];
  #byName = new Map<string, QualifiedName>();

  constructor(mcp: HubMcpId, deps: HubMcpSourcesDeps) {
    this.#mcp = mcp;
    this.#deps = deps;
  }

  prompts(): readonly McpPrompt[] {
    return this.#listed;
  }

  /** Rebuild the list from the scope now. */
  async refresh(): Promise<void> {
    const scope = await this.#deps.scopes().scope(this.#mcp);
    const prompts: McpPrompt[] = [];
    const byName = new Map<string, QualifiedName>();
    for (const name of [...scope.context].sort()) {
      const record = await this.#deps.catalog().context(name);
      const command = record?.decl.command;
      if (record === undefined || command === undefined || record.decl.content === undefined) continue;
      byName.set(command.name, name);
      prompts.push({
        name: command.name, title: splitName(name).local, description: record.decl.description,
        arguments: command.args.map((arg) => ({ name: arg.name, description: arg.hint, required: arg.required })),
      });
    }
    this.#listed = prompts;
    this.#byName = byName;
  }

  async get(name: string, args: Readonly<Record<string, string>>): Promise<McpPromptResult | undefined> {
    const item = this.#byName.get(name);
    if (item === undefined || !(await this.#deps.scopes().scope(this.#mcp)).context.has(item)) return undefined;
    const record = await this.#deps.catalog().context(item);
    const content = record?.decl.content;
    if (content === undefined) return undefined;
    const given = Object.entries(args).map(([key, value]) => `${key}: ${value}`).join('\n');
    return {
      description: record?.decl.description,
      messages: [{ role: 'user', content: { type: 'text', text: given === '' ? content : `${content}\n\n${given}` } }],
    };
  }
}
