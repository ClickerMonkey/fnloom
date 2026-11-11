/**
 * An in-memory context graph that answers the context endpoints the way the hub does: every item filtered and paged,
 * one item with its links both ways, memory named from its words (`memory/<slug>-<n>`), forgetting turning a memory
 * off, links drawn by people and only those removable, and context made from a resource (made again, the same item is
 * updated), refusing as the hub does (`reject` with its status). Records and links are written as their schemas' inputs (`z.input`), so a schema change breaks them at
 * compile time, then parsed. The web tests' fake callers and the mock hub both answer from it.
 */
import {
  ContextFromResourceArgs, ContextItemView, ContextLink, ContextQuery, ContextRecord, LinkTarget, linkTargetKey, QualifiedName, RememberArgs, UpdateMemoryArgs,
  type ActorId, type ContextFromResourceResult, type DeclarableRelation, type Page,
} from '@harness/core';
import { reject } from '@ayepi/core';
import type { z } from 'zod';

/** When the fixtures were written. */
export const T_CONTEXT = 1_700_000_000_000;

/** What a context record may say besides its name, as its schema takes it, with its decl's common fields at the top. */
export type RecordInput = Partial<Omit<z.input<typeof ContextRecord>, 'name' | 'decl'>> & {
  readonly description?: string;
  readonly content?: string;
  readonly command?: string;
  readonly decl?: Partial<z.input<typeof ContextRecord>['decl']>;
};

/** A context record (a system's own, unless `origin` says otherwise). */
export function contextRecord(name: string, input: RecordInput = {}, at = T_CONTEXT): ContextRecord {
  const { description, content, command, decl, ...rest } = input;
  const local = name.split('/').slice(1).join('/');
  const record: z.input<typeof ContextRecord> = {
    name: QualifiedName.parse(name), system: name.split('/')[0] ?? 'hub',
    decl: {
      name: local, description: description ?? `About ${name}`, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [],
      ...(content === undefined ? {} : { content }), ...(command === undefined ? {} : { command: { name: command, args: [] } }), ...decl,
    },
    mentions: { context: [], fns: [] }, stale: false, updatedAt: at, ...rest,
  };
  return ContextRecord.parse(record);
}

/** A link from an item to a target. */
export function contextLink(from: string, to: z.input<typeof LinkTarget>, input: Partial<Omit<z.input<typeof ContextLink>, 'from' | 'to' | 'toKey'>> = {}, at = T_CONTEXT): ContextLink {
  const target = LinkTarget.parse(to);
  const link: z.input<typeof ContextLink> = { from: QualifiedName.parse(from), to: target, toKey: linkTargetKey(target), relation: 'related', weight: 0.5, source: 'declared', updatedAt: at, ...input };
  return ContextLink.parse(link);
}

/** The fixture graph: a skill that brings a fn and imports another, a memory about the skill, and a resource item. */
export function fixtureGraph(author = 'act_ada', at = T_CONTEXT): { records: ContextRecord[]; links: ContextLink[] } {
  return {
    records: [
      contextRecord('fs/guide', { description: 'How to use the file tools', content: '# Files\n\nRead a file with `fs/read`, search with `fs/grep`.\n\n- Paths are relative to the root.\n- Large files are read in pages.', command: 'files', tokens: { full: 120, summary: 14 }, decl: { tags: ['skill'] } }, at),
      contextRecord('fs/shell', { description: 'Running shell commands', content: 'Run commands with `fs/bash`; each asks for approval.' }, at),
      contextRecord('memory/likes-tabs-ab12', {
        system: 'hub', description: 'Likes tabs', content: 'The owner likes tabs, not spaces.', origin: { type: 'memory', scope: { to: 'user', user: author }, author },
      }, at),
      contextRecord('resource/readme-cd34', {
        system: 'hub', description: 'README.md', content: '# Harness\n\nA hub and systems.', origin: { type: 'resource', uri: 'fs://work/README.md', version: '1', copy: 'live' }, stale: true,
      }, at),
    ],
    links: [
      contextLink('fs/guide', { kind: 'context', name: 'fs/shell' }, { relation: 'imports', weight: 1 }, at),
      contextLink('fs/guide', { kind: 'fn', name: 'fs/read' }, { relation: 'brings', weight: 1 }, at),
      contextLink('fs/guide', { kind: 'fn', name: 'fs/grep' }, { relation: 'suggests', weight: 0.4 }, at),
      contextLink('memory/likes-tabs-ab12', { kind: 'context', name: 'fs/guide' }, { relation: 'about', weight: 0.8 }, at),
      contextLink('fs/guide', { kind: 'resource', uri: 'fs://work/README.md' }, { relation: 'related', weight: 0.6, source: 'authored', by: author }, at),
      contextLink('fs/shell', { kind: 'context', name: 'fs/guide' }, { relation: 'learned', weight: 0.3, source: 'learned', uses: 2 }, at),
      contextLink('resource/readme-cd34', { kind: 'resource', uri: 'fs://work/README.md' }, { relation: 'about', weight: 0.9, source: 'resource' }, at),
    ],
  };
}

/** A slug of some words, as memory and resource names use. */
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'item';


/** The in-memory graph. */
export class ContextGraphDouble {
  records: ContextRecord[];
  links: ContextLink[];
  readonly #author: ActorId;
  readonly #clock: () => number;
  #written = 0;

  constructor(author: ActorId, clock: () => number = () => T_CONTEXT, graph = fixtureGraph(author, clock())) {
    this.#author = author;
    this.#clock = clock;
    this.records = [...graph.records];
    this.links = [...graph.links];
  }

  #find(name: QualifiedName): ContextRecord {
    const found = this.records.find((record) => record.name === name);
    if (found === undefined) { throw reject(404, 'NO_CONTEXT', `no context item ${name}`); }
    return found;
  }

  list(input: z.input<typeof ContextQuery>): Page<ContextRecord> {
    const query = ContextQuery.parse(input);
    // this fake knows the list query's words, its `is` filters on origin and system, and an `in` filter on names
    const is = (field: string): string | undefined => {
      const found = query.query?.filters?.find((f) => f.field === field && f.op === 'is');
      return found !== undefined && 'value' in found ? String(found.value) : undefined;
    };
    const origin = is('origin');
    const system = is('system');
    const words = query.query?.text?.toLowerCase();
    const named = query.query?.filters?.find((f) => f.field === 'name' && f.op === 'in');
    const names = named !== undefined && 'values' in named ? new Set(named.values.map(String)) : undefined;
    const shown = this.records
      .filter((record) => names === undefined || names.has(record.name))
      .filter((record) => origin === undefined || (record.origin?.type ?? 'system') === origin)
      .filter((record) => system === undefined || record.system === system)
      .filter((record) => words === undefined || `${record.name}\n${record.decl.description}`.toLowerCase().includes(words));
    const start = Number(query.cursor ?? '0');
    const limit = query.limit ?? 50;
    return { items: shown.slice(start, start + limit), ...(start + limit < shown.length ? { cursor: String(start + limit) } : {}) };
  }

  item(name: QualifiedName): ContextItemView {
    const record = this.#find(name);
    return ContextItemView.parse({
      record, links: this.links.filter((link) => link.from === record.name),
      backlinks: this.links.filter((link) => link.to.kind === 'context' && link.to.name === record.name),
      ...(record.decl.content === undefined ? {} : { text: record.decl.content }),
    });
  }

  remember(input: z.input<typeof RememberArgs>): { name: QualifiedName } {
    const args = RememberArgs.parse(input);
    const title = args.title ?? args.text.split(/\s+/).slice(0, 8).join(' ');
    const name = QualifiedName.parse(`memory/${slug(title)}-${String(++this.#written).padStart(4, '0')}`);
    const scope = args.scope === 'everyone' ? { to: 'everyone' as const } : { to: 'user' as const, user: this.#author };
    this.records = [contextRecord(name, { system: 'hub', description: title, content: args.text, origin: { type: 'memory', scope, author: this.#author } }, this.#clock()), ...this.records];
    for (const to of args.about ?? []) { this.links.push(contextLink(name, to, { relation: 'about', weight: 0.8 }, this.#clock())); }
    return { name };
  }

  update(input: z.input<typeof UpdateMemoryArgs>): { name: QualifiedName } {
    const { name, text, title, about, command, ...o } = UpdateMemoryArgs.parse(input);
    const record = this.#find(name);
    if (record.origin?.type !== 'memory') { throw reject(403, 'NOT_A_MEMORY', `${name} is not a memory; only memories can be edited`); }
    const description = title === undefined || title === '' ? record.decl.description : title;
    const decl = {
      ...record.decl, description,
      ...(o.weight === undefined ? {} : { weight: o.weight }), ...(o.summary === undefined ? {} : { summary: o.summary }), ...(o.tags === undefined ? {} : { tags: o.tags }),
      ...(o.fns === undefined ? {} : { fns: o.fns }), ...(o.suggestFns === undefined ? {} : { suggestFns: o.suggestFns }), ...(o.alwaysFor === undefined ? {} : { alwaysFor: o.alwaysFor }),
      ...(o.visible === undefined ? {} : { visible: o.visible }), ...(o.suggest === undefined ? {} : { suggest: o.suggest }), ...(o.parent === undefined ? {} : { parent: o.parent }),
      ...(text === undefined ? {} : { content: text }), ...(command === undefined ? {} : { command: { name: command, args: [] } }),
    };
    this.records = this.records.map((r) => (r.name === name ? { ...r, decl, updatedAt: this.#clock() } : r));
    if (about !== undefined) {
      this.links = [...this.links.filter((l) => !(l.from === name && l.relation === 'about')), ...about.map((to) => contextLink(name, to, { relation: 'about', weight: 0.8 }, this.#clock()))];
    }
    return { name };
  }

  forget(name: QualifiedName): { ok: boolean } {
    const record = this.#find(name);
    if (record.origin?.type !== 'memory') { throw reject(403, 'NOT_A_MEMORY', `${name} is not a memory; only memories can be forgotten`); }
    if (record.disabled === true) { return { ok: false }; }
    this.records = this.records.map((r) => (r.name === name ? { ...r, disabled: true, updatedAt: this.#clock() } : r));
    return { ok: true };
  }

  link(input: { readonly from: QualifiedName; readonly to: z.input<typeof LinkTarget>; readonly relation: DeclarableRelation; readonly weight: number }): ContextLink {
    this.#find(input.from);
    const made = contextLink(input.from, input.to, { relation: input.relation, weight: input.weight, source: 'authored', by: this.#author }, this.#clock());
    this.links = [...this.links.filter((l) => !(l.from === made.from && l.toKey === made.toKey && l.relation === made.relation)), made];
    return made;
  }

  unlink(key: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): { ok: boolean } {
    const edge = this.links.find((l) => l.from === key.from && l.toKey === key.toKey && l.relation === key.relation);
    if (edge === undefined) { return { ok: false }; }
    if (edge.source !== 'authored') { throw reject(403, 'NOT_AUTHORED', `that ${edge.relation} link comes from ${edge.source}; only links people drew can be removed`); }
    this.links = this.links.filter((l) => l !== edge);
    return { ok: true };
  }

  fromResource(input: z.input<typeof ContextFromResourceArgs>): ContextFromResourceResult {
    const args = ContextFromResourceArgs.parse(input);
    const file = args.uri.split('/').at(-1) ?? 'resource';
    const name = QualifiedName.parse(`resource/${slug(file)}-ef56`);
    const known = this.records.some((r) => r.name === name);
    const record = contextRecord(name, {
      system: 'hub', description: file, content: `Made from ${args.uri}.`, origin: { type: 'resource', uri: args.uri, version: '1', copy: args.copy },
      ...(args.command === undefined ? {} : { command: args.command }),
    }, this.#clock());
    this.records = [record, ...this.records.filter((r) => r.name !== name)];
    if (!known) { this.links.push(contextLink(name, { kind: 'resource', uri: args.uri }, { relation: 'about', weight: 0.9, source: 'resource' }, this.#clock())); }
    return known ? { created: [], updated: [name], links: 1 } : { created: [name], updated: [], links: 1 };
  }
}
