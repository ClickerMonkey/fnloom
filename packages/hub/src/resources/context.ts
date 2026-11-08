/**
 * Context made from resources, memory, and the context list (`ContextLibrary`).
 *
 * **From a resource**: one item per section of the resource's primary form, under a resource-level parent that
 * holds the outline. A section longer than `HARNESS_CONTEXT_PIECE_TOKENS` becomes a chain of pieces (`next`), so a
 * small model can take one piece at a time. Each item has `about` edges to the resource (and its section), and the
 * parent has `related` edges to the context made from resources this one links to. Names come from the URI and the
 * section key (`resource/<slug>-<hash>`), so running it again updates the same items, and pieces a shorter section no
 * longer needs are removed. A `live` item is rewritten from the current text whenever its section changes; a
 * `snapshot` item keeps its text and turns stale.
 *
 * **Memory**: `memory/<slug>-<hash>` items for a session, a person or everyone, with `about` links, which `forget`
 * turns off. Every item is the one `ContextRecord`, its declared edges derived by the context graph and its text in
 * the index, so search, the graph contextor and `/command` find it like a system's context.
 */
import { reject } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  ContextFromResourceArgs, qualify, RememberArgs, seesOrigin, type ActorId, type ContextDecl, type ContextFromResourceResult, type ContextItemView, type ContextLink,
  type ContextOrigin, type ContextQuery, type ContextRecord, type DeclarableRelation, type LinkTarget, type MemoryScope, type Page, type QualifiedName,
  type ResourceUri, type Section, type SectionKey,
} from '@harness/core';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { allRows } from '../catalog/rows.ts';
import type { ContextGraph, DynamicContext } from '../contextor/index.ts';
import type { Indexer } from '../index/index.ts';
import { contextText } from '../index/indexer.ts';
import { sha256Hex } from '../link/keys.ts';
import type { HubStore } from '../store/index.ts';
import type { ResourcesEnv } from './env.ts';
import type { Asking, ContextLibrary, FormService, ResourceReader } from './index.ts';
import { CHARS_PER_TOKEN, estimateTokens } from './rules.ts';

/** The name prefixes of memory and of context made from resources (both reserved system names). */
export const MEMORY = 'memory';
export const RESOURCE = 'resource';

/** How many items a context page holds when the browser doesn't say. */
const PAGE_SIZE = 50;
/** The longest slug in a made name. */
const SLUG_MAX = 40;
/** The weight of an item's `about` edge to what it was made from, and of a parent's `related` edges. */
const ABOUT_WEIGHT = 1;
const RELATED_WEIGHT = 0.4;

/** A name's slug: lowercase words joined by dashes, starting with a letter (`LocalName`'s shape), never empty. */
export function slugOf(text: string): string {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return /^[a-z]/.test(slug) ? slug : `r-${slug}`.replace(/-+$/, '');
}

/** A made item's name: its prefix, a slug, and a short hash of what it stands for, so the same source gives the same name. */
export function madeName(prefix: typeof MEMORY | typeof RESOURCE, words: string, identity: string): QualifiedName {
  return qualify(prefix, `${slugOf(words)}-${sha256Hex(identity).slice(0, 8)}`);
}

/** The text of a section split into pieces of at most `maxChars`, at paragraph (else line, else hard) breaks. */
export function piecesOf(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) { return [text]; }
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const at = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ')].find((i) => i > maxChars / 2) ?? maxChars;
    pieces.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== '') { pieces.push(rest); }
  return pieces;
}

/** What the context library needs. */
export interface StoreContextLibraryOptions {
  readonly store: HubStore;
  readonly forms: () => FormService;
  readonly reader: () => ResourceReader;
  readonly graph: () => ContextGraph;
  readonly indexer: () => Pick<Indexer, 'upsert' | 'remove'>;
  readonly log: Logger;
  readonly clock: () => number;
  readonly settings: Pick<ResourcesEnv, 'HARNESS_CONTEXT_PIECE_TOKENS'>;
  /** The hub's own actor: who rewrites live context when its source changes. */
  readonly hubActor: ActorId;
  /** Told when an item was written, linked or forgotten. */
  readonly onContext?: (name: QualifiedName) => void;
  /** Dynamic context's text from its system, for `item` (default: none, so a dynamic item comes without text). */
  readonly dynamic?: () => DynamicContext;
}

/** One item to write, with the resource edges it gets. */
interface Made {
  readonly record: ContextRecord;
  readonly edges: ReadonlyArray<Pick<ContextLink, 'to' | 'relation' | 'weight'>>;
}

/** Context over the hub's store, the context graph and the index. */
export class StoreContextLibrary implements ContextLibrary {
  readonly #o: StoreContextLibraryOptions;

  constructor(options: StoreContextLibraryOptions) {
    this.#o = options;
  }

  async fromResource(input: ContextFromResourceArgs, who: Asking): Promise<ContextFromResourceResult> {
    const args = ContextFromResourceArgs.parse(input);
    const { store, graph, indexer, log } = this.#o;
    const primary = await this.#o.forms().primary(args.uri, who, { make: true });
    const sections = await this.#o.reader().outline(args.uri, who);
    const chosen = args.sections === undefined ? sections : sections.filter((section) => args.sections?.includes(section.key) === true);
    if (args.sections !== undefined && chosen.length === 0) { throw reject(404, 'NO_SECTION', `${args.uri} has none of the sections ${args.sections.join(', ')}`); }
    const origin = (section?: SectionKey): ContextOrigin => ({
      type: 'resource', uri: args.uri, version: primary.stat.version, copy: args.copy, ...(section === undefined ? {} : { section }),
    });
    const parent = madeName(RESOURCE, primary.stat.name, args.uri);
    const items: Made[] = [];
    for (const section of chosen) { items.push(...this.#pieces(section, primary.text.slice(section.start, section.end), { args, parent, name: primary.stat.name, origin: origin(section.key) })); }
    const related = await this.#relatedTo(primary.links.flatMap((link) => (link.uri === undefined ? [] : [link.uri])));
    items.unshift(this.#parentItem({ args, parent, name: primary.stat.name, origin: origin(), sections: chosen, children: items, related }));

    const before = (await this.#madeFrom(args.uri)).filter((record) => args.sections === undefined || record.origin?.type !== 'resource' || record.origin.section === undefined || args.sections.includes(record.origin.section));
    const names = new Set(items.map((item) => item.record.name));
    const known = new Set(before.map((record) => record.name));
    const dropped = before.filter((record) => !names.has(record.name)).map((record) => record.name);
    let links = 0;
    for (const item of items) {
      await store.table('context').put(item.record);
      await graph().derive(item.record);
      await graph().replaceResourceLinks(item.record.name, item.edges);
      links += item.edges.length;
    }
    for (const name of dropped) { await this.#drop(name); }
    await indexer().upsert(items.map((item) => ({ kind: 'context', key: item.record.name, text: contextText(item.record.name, item.record.decl), system: HUB_SYSTEM })), { vectors: 'background' });
    for (const item of items) { this.#o.onContext?.(item.record.name); }
    const created = items.filter((item) => !known.has(item.record.name)).map((item) => item.record.name);
    const updated = items.filter((item) => known.has(item.record.name)).map((item) => item.record.name);
    log.info('context.from_resource', { uri: args.uri, copy: args.copy, created: created.length, updated: updated.length, dropped: dropped.length, links });
    return { created, updated, links };
  }

  async remember(input: RememberArgs, who: Asking): Promise<{ name: QualifiedName }> {
    const args = RememberArgs.parse(input);
    const scope = this.#scope(args.scope, who);
    const title = args.title?.trim() || args.text.trim().split(/\s+/).slice(0, 8).join(' ');
    const name = madeName(MEMORY, title, `${JSON.stringify(scope)}\n${args.text}`);
    const decl = this.#decl(name, {
      description: title, content: args.text, ...(args.weight === undefined ? {} : { weight: args.weight }),
      links: (args.about ?? []).map((to) => ({ to, relation: 'about', weight: ABOUT_WEIGHT })),
    });
    const record = this.#record(name, decl, { type: 'memory', scope, author: who.actor, ...(who.run === undefined ? {} : { run: who.run }) });
    await this.#o.store.table('context').put(record);
    await this.#o.graph().derive(record);
    await this.#o.indexer().upsert([{ kind: 'context', key: name, text: contextText(name, decl), system: HUB_SYSTEM }], { vectors: 'background' });
    this.#o.onContext?.(name);
    this.#o.log.info('context.remembered', { name, scope: scope.to, chars: args.text.length });
    return { name };
  }

  async forget(name: QualifiedName, who: Asking): Promise<boolean> {
    const record = await this.#visible(name, who);
    if (record.origin?.type !== 'memory') { throw reject(403, 'NOT_A_MEMORY', `${name} is not a memory; only memories can be forgotten`); }
    if (record.disabled === true) { return false; }
    await this.#o.store.table('context').put({ ...record, disabled: true, updatedAt: this.#o.clock() });
    await this.#o.indexer().remove('context', [name]);
    this.#o.onContext?.(name);
    this.#o.log.info('context.forgotten', { name });
    return true;
  }

  async list(query: ContextQuery, who: Asking): Promise<Page<ContextRecord>> {
    const rows = await allRows(this.#o.store.table('context'), query.system === undefined ? undefined : { system: query.system });
    const search = query.search?.trim().toLowerCase();
    const shown = rows
      .filter((record) => seesOrigin(record.origin, who))
      .filter((record) => query.origin === undefined || (record.origin?.type ?? 'system') === query.origin)
      .filter((record) => search === undefined || search === '' || `${record.name}\n${record.decl.description}`.toLowerCase().includes(search))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    const start = query.cursor === undefined ? 0 : Math.max(0, Number.parseInt(query.cursor, 10) || 0);
    const limit = query.limit ?? PAGE_SIZE;
    return { items: shown.slice(start, start + limit), ...(start + limit < shown.length ? { cursor: String(start + limit) } : {}) };
  }

  async item(name: QualifiedName, who: Asking): Promise<ContextItemView> {
    const found = await this.#visible(name, who);
    const [record, links, backlinks] = await Promise.all([
      this.#o.dynamic?.().resolve(found, { session: who.session, actor: who.actor }) ?? found, this.#o.graph().links(name), this.#o.graph().backlinks({ kind: 'context', name }),
    ]);
    const text = record.decl.content;
    if (text === undefined) { return { record, links, backlinks }; }
    // a dynamic item's size is known once its system wrote it
    const sized = found.decl.content === undefined ? { ...record, tokens: { full: estimateTokens(text), summary: estimateTokens(record.decl.summary ?? record.decl.description) } } : record;
    return { record: sized, links, backlinks, text };
  }

  async link(input: { from: QualifiedName; to: LinkTarget; relation: DeclarableRelation; weight: number }, who: Asking): Promise<ContextLink> {
    await this.#visible(input.from, who);
    const made = await this.#o.graph().author({ ...input, by: who.actor });
    this.#o.onContext?.(input.from);
    return made;
  }

  async unlink(key: Pick<ContextLink, 'from' | 'toKey' | 'relation'>, who: Asking): Promise<boolean> {
    await this.#visible(key.from, who);
    const edge = (await this.#o.graph().links(key.from)).find((candidate) => candidate.toKey === key.toKey && candidate.relation === key.relation);
    if (edge === undefined) { return false; }
    if (edge.source !== 'authored') { throw reject(403, 'NOT_AUTHORED', `that ${edge.relation} link comes from ${edge.source === 'declared' ? 'the item itself' : `the hub (${edge.source})`}; only links people drew can be removed`); }
    const removed = await this.#o.graph().remove(key);
    if (removed) { this.#o.onContext?.(key.from); }
    return removed;
  }

  async sectionsChanged(uri: ResourceUri, changed: readonly SectionKey[]): Promise<number> {
    const touched = new Set<string>(changed);
    const made = (await this.#madeFrom(uri)).filter((record) => record.origin?.type === 'resource' && record.origin.section !== undefined && touched.has(record.origin.section));
    const live = new Map<SectionKey, ContextRecord>();
    for (const record of made) {
      if (record.origin?.type !== 'resource' || record.origin.section === undefined) { continue; }
      if (record.origin.copy === 'live') { live.set(record.origin.section, record); continue; }
      if (!record.stale) { await this.#o.store.table('context').put({ ...record, stale: true, updatedAt: this.#o.clock() }); this.#o.onContext?.(record.name); }
    }
    if (live.size > 0) {
      const [sample] = live.values();
      const who: Asking = { actor: this.#o.hubActor };
      const kept = await this.#o.reader().outline(uri, who);
      const still = [...live.keys()].filter((key) => kept.some((section) => section.key === key));
      if (still.length > 0) {
        await this.fromResource(ContextFromResourceArgs.parse({
          uri, sections: still, copy: 'live', ...(sample?.decl.weight === undefined ? {} : { weight: sample.decl.weight }), ...(sample === undefined || sample.decl.alwaysFor.length === 0 ? {} : { alwaysFor: sample.decl.alwaysFor }),
        }), who);
      }
    }
    this.#o.log.info('context.sections.changed', { uri, items: made.length, live: live.size });
    return made.length;
  }

  /** The items of one section: one, or a chain of pieces when it is long. */
  #pieces(section: Section, text: string, at: { args: ContextFromResourceArgs; parent: QualifiedName; name: string; origin: ContextOrigin }): Made[] {
    const { args, parent, origin } = at;
    const maxChars = this.#o.settings.HARNESS_CONTEXT_PIECE_TOKENS * CHARS_PER_TOKEN;
    const pieces = piecesOf(text, maxChars);
    const identity = `${args.uri}#${section.key}`;
    const names = pieces.map((_piece, i) => madeName(RESOURCE, `${at.name} ${section.title}${i === 0 ? '' : ` ${i + 1}`}`, i === 0 ? identity : `${identity}~${i + 1}`));
    const title = section.path.length > 0 ? section.path.join(' > ') : section.title;
    return pieces.map((piece, i) => {
      const name = names[i] ?? parent;
      const next = names[i + 1];
      const decl = this.#decl(name, {
        description: `${title}${pieces.length > 1 ? ` (part ${i + 1} of ${pieces.length})` : ''}, from ${at.name}`, content: piece, parent,
        ...(next === undefined ? {} : { next }), ...(args.weight === undefined ? {} : { weight: args.weight }), alwaysFor: args.alwaysFor ?? [],
      });
      return { record: this.#record(name, decl, origin), edges: [{ to: { kind: 'resource', uri: args.uri, section: section.key }, relation: 'about', weight: ABOUT_WEIGHT }] };
    });
  }

  /** The resource-level item: the outline of the sections made, the parent of each. */
  #parentItem(at: { args: ContextFromResourceArgs; parent: QualifiedName; name: string; origin: ContextOrigin; sections: readonly Section[]; children: readonly Made[]; related: readonly QualifiedName[] }): Made {
    const { args, parent } = at;
    const outline = at.sections.map((section) => `${'  '.repeat(Math.max(0, section.path.length - 1))}- ${section.title}`).join('\n');
    const first = at.children[0]?.record.name;
    const decl = this.#decl(parent, {
      description: `${at.name}: what it holds, section by section`, content: `${at.name} (${args.uri})\n\n${outline}`,
      ...(args.weight === undefined ? {} : { weight: args.weight }), alwaysFor: args.alwaysFor ?? [],
      ...(args.command === undefined ? {} : { command: { name: args.command, args: [] } }),
      ...(first === undefined ? {} : { next: first }),
    });
    return {
      record: this.#record(parent, decl, at.origin),
      edges: [
        { to: { kind: 'resource', uri: args.uri }, relation: 'about', weight: ABOUT_WEIGHT },
        ...at.related.map((name) => ({ to: { kind: 'context', name } satisfies LinkTarget, relation: 'related' as const, weight: RELATED_WEIGHT })),
      ],
    };
  }

  /** A context declaration with the defaults every made item shares. */
  #decl(name: QualifiedName, fields: Partial<ContextDecl> & Pick<ContextDecl, 'description'>): ContextDecl {
    const local = name.slice(name.indexOf('/') + 1);
    return {
      name: local, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [], ...fields,
      ...(fields.content === undefined ? {} : { summary: fields.summary ?? fields.description }),
    };
  }

  /** A made item's record. */
  #record(name: QualifiedName, decl: ContextDecl, origin: ContextOrigin): ContextRecord {
    const content = decl.content ?? '';
    return {
      name, system: HUB_SYSTEM, origin, decl, mentions: { context: [], fns: [] }, stale: false, updatedAt: this.#o.clock(),
      tokens: { full: estimateTokens(content), summary: estimateTokens(decl.summary ?? decl.description) },
    };
  }

  /** The resource-level items made from resources a resource links to. */
  async #relatedTo(uris: readonly ResourceUri[]): Promise<QualifiedName[]> {
    if (uris.length === 0) { return []; }
    const wanted = new Set<string>(uris);
    const rows = await allRows(this.#o.store.table('context'), { system: HUB_SYSTEM });
    return rows.filter((record) => record.origin?.type === 'resource' && record.origin.section === undefined && wanted.has(record.origin.uri)).map((record) => record.name);
  }

  /** Every item made from one resource. */
  async #madeFrom(uri: ResourceUri): Promise<ContextRecord[]> {
    const rows = await allRows(this.#o.store.table('context'), { system: HUB_SYSTEM });
    return rows.filter((record) => record.origin?.type === 'resource' && record.origin.uri === uri);
  }

  /** Remove a made item, its edges and its index entry. */
  async #drop(name: QualifiedName): Promise<void> {
    const { store, graph, indexer } = this.#o;
    await graph().replaceResourceLinks(name, []);
    for (const edge of await graph().links(name)) { await graph().remove(edge); }
    await store.table('context').remove(name);
    await indexer().remove('context', [name]);
  }

  /** The scope a memory is written for. */
  #scope(scope: RememberArgs['scope'], who: Asking): MemoryScope {
    switch (scope) {
      case 'session':
        if (who.session === undefined) { throw reject(422, 'NO_SESSION', 'a session memory can only be written from a chat session; remember it for the person or everyone'); }
        return { to: 'session', session: who.session };
      case 'user': return { to: 'user', user: who.actor };
      case 'everyone': return { to: 'everyone' };
    }
  }

  /** An item the person may see, or 404. */
  async #visible(name: QualifiedName, who: Asking): Promise<ContextRecord> {
    const record = await this.#o.store.table('context').get(name);
    if (record === undefined || !seesOrigin(record.origin, who)) { throw reject(404, 'NO_CONTEXT', `there is no context ${name}`); }
    return record;
  }
}
