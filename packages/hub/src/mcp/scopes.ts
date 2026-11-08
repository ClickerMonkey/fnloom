/**
 * What a hub MCP exposes (`McpScopes`): its rules resolved against the catalog, live. `resolveRules` is the one rule,
 * given what the hub knows now (`ScopeWorld`); `CatalogMcpScopes` gathers that world from the catalog and the
 * resource router, and keeps each MCP's scope until the MCP, the catalog, a system's status or its roots change.
 *
 * - A fn is exposed when it can be used now (available, switched on), people's agents may see it (visibility `llm`
 *   or `both`), `include` selects it (its system, or an `FnMatch`), `exclude` doesn't, and it isn't tagged `admin`:
 *   nothing reached through an MCP may change what an MCP reaches. An `FnMatch` with a `when` predicate can't be
 *   judged before a call, so it never includes and always excludes.
 * - A type is exposed when selected, or when an exposed fn's signature needs it (the closure): a needed type that is
 *   excluded is exposed all the same, with a warning.
 * - Context is exposed when selected; a context item that would bring a fn that isn't exposed is warned about (it
 *   brings only exposed fns).
 * - A resource is exposed when its URI starts with a selected prefix (served by the prefix's system and instance,
 *   when it names them), or its system is selected, and no exclude selects it.
 */
import {
  ADMIN_TAG, ResourceUri, type FnMatch, type FnRecord, type HubMcpId, type McpRules, type McpScopePreview, type McpSelector, type NameGlob, type PolicyDecision,
  type QualifiedName, type ResourceSelector, type SystemName,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { GinScopes } from '../catalog/scope.ts';
import { globMatches, targetRank } from '../execution/policies.ts';
import type { ResourceRouter } from '../link/index.ts';
import type { McpRegistry, McpScope, McpScopes } from './index.ts';

/** A named thing of a system (a type or a context item) as scopes see it. */
export interface ScopeEntry {
  readonly name: QualifiedName;
  readonly system: SystemName;
}

/** What the hub knows now, as rules are resolved against it. */
export interface ScopeWorld {
  readonly fns: readonly FnRecord[];
  readonly types: readonly ScopeEntry[];
  /** Context items with the fns they bring. */
  readonly context: ReadonlyArray<ScopeEntry & { readonly fns: readonly QualifiedName[] }>;
  /** Every resource root served now, by system. */
  readonly roots: readonly ResourceSelector[];
  /** The named types a fn's signature uses directly. */
  references(fn: FnRecord): readonly QualifiedName[];
  /** Types and every type they use, dependencies first. */
  closure(names: readonly QualifiedName[]): Promise<{ order: QualifiedName[]; missing: QualifiedName[] }>;
}

/** Whether a fn may ever be exposed through an MCP, whatever the rules say. */
export function exposable(fn: FnRecord): boolean {
  return fn.available === true && !fn.disabled && !fn.decl.tags.includes(ADMIN_TAG) && (fn.decl.visibility === 'llm' || fn.decl.visibility === 'both');
}

/** Whether a selector selects a fn: its system, or one of its matchers (judged for `effect`, see the module notes). */
function selectsFn(selector: McpSelector, fn: FnRecord, effect: Exclude<PolicyDecision['effect'], 'ask'>): boolean {
  if (selector.systems?.includes(fn.system) === true) return true;
  return (selector.fns ?? []).some((match: FnMatch) => targetRank(match, fn, effect) !== undefined);
}

/** Whether a selector selects a named thing: its system, or one of the globs. */
function selectsName(selector: McpSelector, entry: ScopeEntry, globs: readonly NameGlob[] | undefined): boolean {
  return selector.systems?.includes(entry.system) === true || (globs ?? []).some((glob) => globMatches(glob, entry.name));
}

/** What serves a resource, as far as it is known: its system, and the instance when known. */
export type ResourceServer = Omit<ResourceSelector, 'uri'> & { readonly system: SystemName };

/**
 * Whether a selector selects a resource URI (served by `server`, when known): a selected system, or a prefix whose
 * system and instance, when it names them, are the ones serving it.
 */
export function selectsResource(selector: McpSelector, uri: string, server: ResourceServer | undefined): boolean {
  if (server !== undefined && selector.systems?.includes(server.system) === true) return true;
  return (selector.resources ?? []).some((r) => uri.startsWith(r.uri)
    && (r.system === undefined || r.system === server?.system)
    && (r.instance === undefined || r.instance === server?.instance));
}

/** The server a resource selector names, when it names a system. */
function serverOf(selector: ResourceSelector): ResourceServer | undefined {
  return selector.system === undefined ? undefined : { system: selector.system, ...(selector.instance === undefined ? {} : { instance: selector.instance }) };
}

/** Resolve rules against what the hub knows now. */
export async function resolveRules(rules: McpRules, world: ScopeWorld): Promise<McpScopePreview> {
  const { include, exclude } = rules;
  const warnings: string[] = [];
  const fns = world.fns.filter((fn) => exposable(fn) && selectsFn(include, fn, 'allow') && !selectsFn(exclude, fn, 'deny'));
  const exposedFns = new Set(fns.map((fn) => fn.name));

  const selectedTypes = world.types.filter((t) => selectsName(include, t, include.types) && !selectsName(exclude, t, exclude.types)).map((t) => t.name);
  const excludedTypes = new Set(world.types.filter((t) => selectsName(exclude, t, exclude.types)).map((t) => t.name));
  const needed = [...new Set(fns.flatMap((fn) => world.references(fn)))];
  const closure = needed.length === 0 ? [] : (await world.closure(needed)).order;
  const users = (type: QualifiedName): string => fns.filter((fn) => world.references(fn).includes(type)).map((fn) => fn.name).join(', ') || 'another exposed type';
  for (const type of closure) {
    if (excludedTypes.has(type)) warnings.push(`${type} is excluded, but ${users(type)} needs it, so it is exposed.`);
  }
  const types = [...new Set([...selectedTypes, ...closure])].sort();
  const pulled = closure.filter((type) => !selectedTypes.includes(type)).sort();

  const context = world.context.filter((c) => selectsName(include, c, include.context) && !selectsName(exclude, c, exclude.context));
  for (const item of context) {
    const hidden = item.fns.filter((fn) => !exposedFns.has(fn));
    if (hidden.length > 0) warnings.push(`${item.name} brings ${hidden.join(', ')}, which ${hidden.length === 1 ? 'is' : 'are'} not exposed; it brings only exposed fns.`);
  }

  const resources = [
    ...(include.resources ?? []),
    ...world.roots.filter((root) => root.system !== undefined && include.systems?.includes(root.system) === true),
  ].filter((r) => !selectsResource(exclude, r.uri, serverOf(r)));
  // resource rules bound what the MCP lists and what the hub's resource fns read, not a system's own fns
  if ((include.resources ?? []).length > 0 || (exclude.resources ?? []).length > 0) {
    const serving = new Set(world.roots.flatMap((root) => (root.system === undefined ? [] : [root.system])));
    for (const system of [...new Set(fns.map((fn) => fn.system))].filter((s) => serving.has(s)).sort()) {
      warnings.push(`${system}'s exposed fns read its files by path: resource rules don't limit them, only what is listed and what the hub's resource fns read.`);
    }
  }

  const byName = new Map(world.fns.map((fn) => [fn.name, fn]));
  const reach = new Set<QualifiedName>();
  const pending = fns.flatMap((fn) => fn.decl.deps);
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || reach.has(next) || exposedFns.has(next)) continue;
    reach.add(next);
    pending.push(...(byName.get(next)?.decl.deps ?? []));
  }

  return {
    fns: [...exposedFns].sort(), types, closure: pulled, context: context.map((c) => c.name).sort(), resources, reach: [...reach].sort(), warnings,
  };
}

/** A scope from a resolved preview and the rules (resources are judged per URI, by the system serving it). */
export function scopeOf(rules: McpRules, preview: McpScopePreview, serverOf: (uri: string) => ResourceServer | undefined): McpScope {
  return {
    fns: new Set(preview.fns),
    types: new Set(preview.types),
    context: new Set(preview.context),
    allowsResource: (uri) => {
      const server = serverOf(uri);
      return selectsResource(rules.include, uri, server) && !selectsResource(rules.exclude, uri, server);
    },
  };
}

/** What the scopes read. */
export interface CatalogMcpScopesDeps {
  readonly catalog: () => Pick<Catalog, 'fns' | 'entries' | 'typeClosure'>;
  readonly resources: () => Pick<ResourceRouter, 'roots' | 'route'>;
  readonly registry: () => Pick<McpRegistry, 'record'>;
  readonly bus: EventBus;
}

/** MCP scopes over the catalog, cached until something they depend on changes. */
export class CatalogMcpScopes implements McpScopes {
  readonly #deps: CatalogMcpScopesDeps;
  readonly #ginScopes = new GinScopes();
  readonly #cache = new Map<HubMcpId, { readonly updatedAt: number; readonly scope: Promise<McpScope> }>();

  constructor(deps: CatalogMcpScopesDeps) {
    this.#deps = deps;
    const drop = (): void => { this.#cache.clear(); };
    deps.bus.subscribe('catalog.changed', drop);
    deps.bus.subscribe('system.status', drop);
    deps.bus.subscribe('resources.roots', drop);
    deps.bus.subscribe('mcp.changed', ({ mcp }) => { this.#cache.delete(mcp); });
  }

  async scope(mcp: HubMcpId): Promise<McpScope> {
    const record = await this.#deps.registry().record(mcp);
    if (record === undefined) return { fns: new Set(), types: new Set(), context: new Set(), allowsResource: () => false };
    const cached = this.#cache.get(mcp);
    if (cached?.updatedAt === record.updatedAt) return cached.scope;
    const scope = this.preview(record.rules).then((preview) => scopeOf(record.rules, preview, (uri) => this.#serverOf(uri)));
    this.#cache.set(mcp, { updatedAt: record.updatedAt, scope });
    scope.catch(() => { this.#cache.delete(mcp); });
    return scope;
  }

  /** The system and instance serving a URI now, when one does. */
  #serverOf(uri: string): ResourceServer | undefined {
    const parsed = ResourceUri.safeParse(uri);
    const route = parsed.success ? this.#deps.resources().route(parsed.data) : undefined;
    return route === undefined ? undefined : { system: route.system, instance: route.instance };
  }

  async preview(rules: McpRules): Promise<McpScopePreview> {
    return resolveRules(rules, await this.#world());
  }

  /** What the catalog and the router hold now. */
  async #world(): Promise<ScopeWorld> {
    const catalog = this.#deps.catalog();
    const [fns, types, context] = await Promise.all([catalog.fns({}), catalog.entries('types'), catalog.entries('context')]);
    const references = new Map<QualifiedName, readonly QualifiedName[]>();
    const refsOf = (fn: FnRecord): readonly QualifiedName[] => {
      const known = references.get(fn.name);
      if (known !== undefined) return known;
      let found: QualifiedName[] = [];
      try {
        found = [...new Set([...this.#ginScopes.references(fn.decl.args), ...this.#ginScopes.references(fn.decl.returns)])];
      } catch {
        // a signature that no longer parses names no types; the fn is unavailable anyway
      }
      references.set(fn.name, found);
      return found;
    };
    return {
      fns,
      types: types.map((t) => ({ name: t.name, system: t.system })),
      context: context.map((c) => ({ name: c.name, system: c.system, fns: c.decl.fns })),
      roots: this.#deps.resources().roots().map((r) => ({ uri: r.root.uri, system: r.system, instance: r.instance })),
      references: refsOf,
      closure: (names) => catalog.typeClosure(names),
    };
  }
}
