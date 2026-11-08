/**
 * The context pages' pure parts: the `/context` URL's query (`ContextBrowseQuery`; its `q` is the list's written query)
 * and the hub query made from it;
 * plain words for an item's origin, a link's relation and where a link came from; links grouped by relation, strongest
 * first; what a link points at, in words; whether a person may remove a link; and the add-link and memory drafts read
 * into the hub's own argument shapes (`LinkTarget`, `RememberArgs`) with one plain problem when they don't parse.
 */
import {
  ContextFromResourceArgs, ContextOptions, ContextQuery, UpdateMemoryArgs, HUB_RESOURCE_ROOT, type DeclarableRelation, LinkTarget, QualifiedName, RememberArgs, ResourceUri, SectionKey, type ListQuery,
  type ContextCopy, type ContextLink, type ContextOriginType, type ContextRecord, type LinkRelation, type LinkSource, type LinkTargetKind, type MemoryScope, type Audience,
} from '@harness/core';
import { z } from 'zod';
import type { IconName, Outcome } from '../../ui/index.ts';

/** The origins the list filters by (an origin's type; `system` when a record has none), as the hub's query takes them. */
export const OriginChoice = ContextQuery.shape.origin.unwrap();

/** The `/context` page's query: the list's written query (`origin:memory tabs`), and the dialogs open over it. */
export const ContextBrowseQuery = z.object({
  q: z.string(),
  /** The "remember something" dialog. */
  remember: z.literal('1'),
  /** The "make context from a resource" dialog. */
  from: z.literal('1'),
}).partial();
export type ContextBrowseQuery = z.infer<typeof ContextBrowseQuery>;

/** The `/context` query read from the URL's values: each key kept only when it parses, blanks left out. */
export function readContextQuery(raw: Readonly<Record<string, string>>): ContextBrowseQuery {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === '') { continue; }
    const one = ContextBrowseQuery.safeParse({ [key]: value });
    if (one.success && key in one.data) { out[key] = value; }
  }
  return ContextBrowseQuery.parse(out);
}

/** The item page's query: the dialogs open over it. */
export const ContextItemQuery = z.object({ link: z.literal('1'), edit: z.literal('1') }).partial();
export type ContextItemQuery = z.infer<typeof ContextItemQuery>;

/** What the list asks the hub for: the list's query (none when it is empty). */
export type ContextFilter = Pick<ContextQuery, 'query'>;

/** The hub's filter for a list query. */
export function filterOf(query: ListQuery): ContextFilter {
  return Object.keys(query).length === 0 ? {} : { query };
}

/** Whether a filter narrows the list (so an empty list says "nothing matches", not "nothing yet"). */
export function isFiltered(filter: ContextFilter): boolean {
  return (filter.query?.text ?? '') !== '' || (filter.query?.filters ?? []).length > 0;
}

/** An item's origin type. */
export function originOf(record: Pick<ContextRecord, 'origin'>): ContextOriginType {
  return record.origin?.type ?? 'system';
}

/** Each origin in words, with its icon. */
export const ORIGIN_WORDS = {
  system: { label: 'From a system', short: 'System', icon: 'server' },
  memory: { label: 'Memory', short: 'Memory', icon: 'sparkles' },
  resource: { label: 'From a resource', short: 'Resource', icon: 'file' },
} as const satisfies Record<ContextOriginType, { readonly label: string; readonly short: string; readonly icon: IconName }>;

/** Who a memory is for, in words. */
export function scopeText(scope: MemoryScope): string {
  switch (scope.to) {
    case 'session': return 'One chat';
    case 'user': return 'Only its author';
    case 'everyone': return 'Everyone';
  }
}

/** Each relation in words: a label, what it means, and its direction read from the other end. */
export const RELATION_WORDS = {
  imports: { label: 'Imports', back: 'Imported by', about: 'Loaded along with this item.' },
  brings: { label: 'Brings', back: 'Brought by', about: 'A fn added to the tools when this item loads.' },
  suggests: { label: 'Suggests', back: 'Suggested by', about: 'A fn worth offering when this item comes up.' },
  parent: { label: 'Parent', back: 'Child', about: 'The item above this one.' },
  next: { label: 'Next', back: 'Comes after', about: 'The next piece of the same long text.' },
  related: { label: 'Related', back: 'Related', about: 'Worth looking at together.' },
  mentions: { label: 'Mentions', back: 'Mentioned by', about: 'Named in the text.' },
  about: { label: 'About', back: 'Has notes', about: 'What a memory or a resource item is about.' },
  learned: { label: 'Used with', back: 'Used with', about: 'Used together in one turn; fades over time.' },
} as const satisfies Record<LinkRelation, { readonly label: string; readonly back: string; readonly about: string }>;

/** Where each link came from, in words. */
export const SOURCE_WORDS = {
  declared: 'Declared by the item',
  mentioned: 'Found in the text',
  resource: 'Made from a resource',
  learned: 'Learned from use',
  authored: 'Drawn by a person',
} as const satisfies Record<LinkSource, string>;

/** What each kind of link target is called. */
export const TARGET_WORDS = {
  context: { label: 'Context', icon: 'layers' },
  fn: { label: 'Fn', icon: 'fn' },
  type: { label: 'Type', icon: 'braces' },
  resource: { label: 'Resource', icon: 'file' },
} as const satisfies Record<LinkTargetKind, { readonly label: string; readonly icon: IconName }>;

/** What a link target is, in words: its name, or a resource's URI with its section. */
export function targetText(target: LinkTarget): string {
  switch (target.kind) {
    case 'context': case 'fn': case 'type': return target.name;
    case 'resource': return target.section === undefined ? target.uri : `${target.uri} § ${target.section}`;
  }
}

/** A link's identity, as the hub keys it (its start, its target's key and its relation). */
export function linkKey(link: Pick<ContextLink, 'from' | 'toKey' | 'relation'>): string {
  return `${link.from}|${link.toKey}|${link.relation}`;
}

/** Whether a person may remove a link: only links people drew; the rest are the item's own or the hub's. */
export function removable(link: Pick<ContextLink, 'source'>): boolean {
  return link.source === 'authored';
}

/** Links of one relation. */
export interface LinkGroup {
  readonly relation: LinkRelation;
  readonly links: readonly ContextLink[];
}

/** Links grouped by relation in the order `RELATION_WORDS` lists them, each group strongest first. */
export function groupLinks(links: readonly ContextLink[]): LinkGroup[] {
  const order = Object.keys(RELATION_WORDS);
  const groups = new Map<LinkRelation, ContextLink[]>();
  for (const link of links) { groups.set(link.relation, [...(groups.get(link.relation) ?? []), link]); }
  return [...groups.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([relation, list]) => ({ relation, links: [...list].sort((a, b) => b.weight - a.weight || a.toKey.localeCompare(b.toKey)) }));
}

/** A weight as a percentage for a bar (0 to 100). */
export function weightPercent(weight: number): number {
  return Math.round(Math.min(1, Math.max(0, weight)) * 100);
}

// ─── Drafts ───────────────────────────────────────────────────────────────

/** The add-link form as typed. */
export interface LinkDraft {
  readonly kind: LinkTargetKind;
  /** A name (context, fn, type) or a resource URI. */
  readonly target: string;
  /** A resource's section, optional. */
  readonly section: string;
  readonly relation: DeclarableRelation;
  readonly weight: number;
}

/** A fresh add-link form. */
export function emptyLinkDraft(): LinkDraft {
  return { kind: 'context', target: '', section: '', relation: 'related', weight: 0.5 };
}

/** The problem with an address that isn't a resource's, with the forms real addresses take. */
const ADDRESS_PROBLEM = `A resource address is a URI, like file:///home/me/notes.md or ${HUB_RESOURCE_ROOT}uploads/notes.md.`;

/**
 * An item's size in words: its full text in tokens, or "Written when loaded" for an item whose system writes its text
 * on each load (no text kept, so nothing to count); undefined when the hub hasn't counted it.
 */
export function sizeText(record: Pick<ContextRecord, 'tokens' | 'decl'>): string | undefined {
  if (record.tokens === undefined) { return undefined; }
  if (record.decl.content === undefined && record.tokens.full === 0) { return 'Written when loaded'; }
  return `${record.tokens.full.toLocaleString()} tokens`;
}

/** What the add-link form asks the hub for, or the one problem with it. */
export type LinkRequest = Outcome<{ readonly to: LinkTarget; readonly relation: DeclarableRelation; readonly weight: number }>;

/** Read the add-link form; `from` is the item it starts at (an item can't link to itself). */
export function linkRequest(draft: LinkDraft, from: QualifiedName): LinkRequest {
  const target = draft.target.trim();
  if (target === '') { return { ok: false, problem: draft.kind === 'resource' ? 'Give the resource\'s address.' : 'Give a name.' }; }
  const weight = Math.min(1, Math.max(0, draft.weight));
  if (draft.kind === 'resource') {
    const uri = ResourceUri.safeParse(target);
    if (!uri.success) { return { ok: false, problem: ADDRESS_PROBLEM }; }
    const section = draft.section.trim();
    const key = section === '' ? undefined : SectionKey.safeParse(section);
    if (key !== undefined && !key.success) { return { ok: false, problem: 'That section name is not valid.' }; }
    return { ok: true, value: { to: LinkTarget.parse({ kind: 'resource', uri: uri.data, ...(key === undefined ? {} : { section: key.data }) }), relation: draft.relation, weight } };
  }
  const name = QualifiedName.safeParse(target);
  if (!name.success) { return { ok: false, problem: 'A name looks like system/name, as in fs/read.' }; }
  if (draft.kind === 'context' && name.data === from) { return { ok: false, problem: 'An item can\'t link to itself.' }; }
  return { ok: true, value: { to: LinkTarget.parse({ kind: draft.kind, name: name.data }), relation: draft.relation, weight } };
}

/** Who a memory written from the browser is for (the browser has no chat, so a memory is the person's or everyone's). */
export const BrowserScope = z.enum(['user', 'everyone']);
export type BrowserScope = z.infer<typeof BrowserScope>;

/** The memory form as typed: the title, the text, who it is for, and the Advanced options. */
export interface MemoryDraft {
  readonly title: string;
  readonly text: string;
  readonly scope: BrowserScope;
  readonly options: ContextOptionsDraft;
}

/** The form's Advanced section as typed: every other context option (`ContextOptions`), tied fns included. */
export interface ContextOptionsDraft {
  /** How much it counts when scored, 0 to 2 (1 is plain). */
  readonly weight: number;
  readonly summary: string;
  readonly tags: readonly string[];
  /** Tied fns: offered whenever the item is loaded. */
  readonly fns: readonly QualifiedName[];
  /** Fns suggested alongside it. */
  readonly suggestFns: readonly QualifiedName[];
  /** Agent fns whose prompts always carry it. */
  readonly alwaysFor: readonly QualifiedName[];
  /** A `/command` that loads it; blank for none. */
  readonly command: string;
  readonly visible: Audience;
  readonly suggest: Audience;
  /** Its parent in a hierarchy; blank for none. */
  readonly parent: string;
}

/** The options a new memory starts with: what the hub gives one when none are said. */
export const PLAIN_OPTIONS: ContextOptionsDraft = { weight: 1, summary: '', tags: [], fns: [], suggestFns: [], alwaysFor: [], command: '', visible: 'both', suggest: 'both', parent: '' };

/** Who sees an item listed and who it is suggested to, in words. */
export const AUDIENCE_WORDS: Readonly<Record<Audience, string>> = { both: 'People and agents', user: 'People', llm: 'Agents', none: 'No one' };

/** How many of the Advanced options differ from a plain memory's (for the section's closed label). */
export function changedOptions(draft: ContextOptionsDraft): number {
  return OPTION_KEYS.filter((key) => differs(draft, key)).length;
}

const OPTION_KEYS = ['weight', 'summary', 'tags', 'fns', 'suggestFns', 'alwaysFor', 'command', 'visible', 'suggest', 'parent'] as const satisfies readonly (keyof ContextOptionsDraft)[];

/** Does an option differ from a plain memory's? */
function differs(draft: ContextOptionsDraft, key: keyof ContextOptionsDraft): boolean {
  return JSON.stringify(draft[key]) !== JSON.stringify(PLAIN_OPTIONS[key]);
}

/** A fresh memory form, or one filled from the memory being edited. */
export function memoryDraft(record?: Pick<ContextRecord, 'origin' | 'decl'>): MemoryDraft {
  if (record?.origin?.type !== 'memory') { return { title: '', text: '', scope: 'user', options: PLAIN_OPTIONS }; }
  const { decl } = record;
  const options: ContextOptionsDraft = {
    weight: decl.weight ?? 1, summary: decl.summary === decl.description ? '' : decl.summary ?? '', tags: decl.tags, fns: decl.fns, suggestFns: decl.suggestFns,
    alwaysFor: decl.alwaysFor, command: decl.command?.name ?? '', visible: decl.visible, suggest: decl.suggest, parent: decl.parent ?? '',
  };
  return { title: decl.description, text: decl.content ?? '', scope: record.origin.scope.to === 'everyone' ? 'everyone' : 'user', options };
}

/**
 * The Advanced options read into the hub's `ContextOptions`, or the one problem with them. `every` sends each option
 * (an edit, so a cleared one is cleared); otherwise only those that differ from a plain memory's.
 */
export function optionsRequest(draft: ContextOptionsDraft, every: boolean): Outcome<ContextOptions> {
  const command = draft.command.trim().replace(/^\//, '');
  if (command !== '' && !ContextOptions.shape.command.unwrap().safeParse(command).success) { return { ok: false, problem: 'A command is lowercase letters, digits and dashes, starting with a letter.' }; }
  const parent = draft.parent.trim();
  if (parent !== '' && !QualifiedName.safeParse(parent).success) { return { ok: false, problem: 'The parent is an item’s full name, like fs/guide.' }; }
  const summary = draft.summary.trim();
  const send = (key: keyof ContextOptionsDraft): boolean => every || differs(draft, key);
  return {
    ok: true,
    value: ContextOptions.parse({
      ...(send('weight') ? { weight: draft.weight } : {}), ...(send('tags') ? { tags: draft.tags } : {}), ...(send('fns') ? { fns: draft.fns } : {}),
      ...(send('suggestFns') ? { suggestFns: draft.suggestFns } : {}), ...(send('alwaysFor') ? { alwaysFor: draft.alwaysFor } : {}),
      ...(send('visible') ? { visible: draft.visible } : {}), ...(send('suggest') ? { suggest: draft.suggest } : {}),
      ...(summary === '' ? {} : { summary }), ...(command === '' ? {} : { command }), ...(parent === '' ? {} : { parent }),
    }),
  };
}

/** What the memory form asks the hub to remember, or the one problem with it. */
export type MemoryRequest = Outcome<RememberArgs>;

/** Read the memory form; `about` is what the memory is about (the item it is written from). */
export function memoryRequest(draft: MemoryDraft, about: readonly LinkTarget[] = []): MemoryRequest {
  const text = draft.text.trim();
  if (text === '') { return { ok: false, problem: 'Write what to remember.' }; }
  const options = optionsRequest(draft.options, false);
  if (!options.ok) { return options; }
  const title = draft.title.trim();
  return { ok: true, value: RememberArgs.parse({ text, scope: draft.scope, ...(title === '' ? {} : { title }), ...(about.length === 0 ? {} : { about }), ...options.value }) };
}

/** Read the memory form as a change to memory `name` (its scope stays as written), or the one problem with it. */
export function memoryUpdate(name: QualifiedName, draft: MemoryDraft): Outcome<UpdateMemoryArgs> {
  const text = draft.text.trim();
  if (text === '') { return { ok: false, problem: 'Write what to remember.' }; }
  const options = optionsRequest(draft.options, true);
  if (!options.ok) { return options; }
  return { ok: true, value: UpdateMemoryArgs.parse({ name, text, title: draft.title.trim(), ...options.value }) };
}

/** The make-from-a-resource form as typed. */
export interface FromResourceDraft {
  readonly uri: string;
  readonly copy: ContextCopy;
  /** A `/command` that loads the resource's item; blank for none. */
  readonly command: string;
}

/** What the make-from-a-resource form asks the hub for, or the one problem with it. */
export type FromResourceRequest = Outcome<ContextFromResourceArgs>;

/** Read the make-from-a-resource form. */
export function fromResourceRequest(draft: FromResourceDraft): FromResourceRequest {
  const uri = ResourceUri.safeParse(draft.uri.trim());
  if (!uri.success) { return { ok: false, problem: ADDRESS_PROBLEM }; }
  const command = draft.command.trim().replace(/^\//, '');
  const args = ContextFromResourceArgs.safeParse({ uri: uri.data, copy: draft.copy, ...(command === '' ? {} : { command }) });
  if (!args.success) { return { ok: false, problem: 'A command is lower-case letters, digits and dashes, starting with a letter.' }; }
  return { ok: true, value: args.data };
}
