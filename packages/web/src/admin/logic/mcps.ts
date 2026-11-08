/**
 * Hub MCPs as the admin pages show them: the five parts of a rule selector (systems, fns, types, context, resources)
 * with their words, reading and writing one part's entries as text, an empty rule set, a slug made from a name, the
 * connect snippets (Claude Code's `claude mcp add` and a `.mcp.json`), and the words of each tool mode. Pure, so it
 * is tested alone.
 */
import {
  FnMatch, McpSelector, McpSlug, NameGlob, ResourceSelector, SystemName, type HubMcpView, type McpRules, type McpToolMode,
} from '@harness/core';

/** The parts of a selector, in the order the editor shows them. */
export const SELECTOR_PARTS = ['systems', 'fns', 'types', 'context', 'resources'] as const satisfies readonly (keyof McpSelector)[];
export type SelectorPart = (typeof SELECTOR_PARTS)[number];

/** What each part selects, and how one entry is written. */
export const SELECTOR_WORDS = {
  systems: { label: 'Systems', about: 'Whole systems: their fns, types, context and resources.', placeholder: 'A system’s name, like fs' },
  fns: { label: 'Fns', about: 'By name or glob (fs/*), or #tag.', placeholder: 'fs/read or fs/* or #read' },
  types: { label: 'Types', about: 'Named types, by name or glob.', placeholder: 'fs/Entry or fs/*' },
  context: { label: 'Context', about: 'Context items, by name or glob.', placeholder: 'fs/docs or memory/*' },
  resources: { label: 'Resources', about: 'URI prefixes, optionally on one system@instance.', placeholder: 'file:// or file:// on fs@laptop' },
} as const satisfies Record<SelectorPart, { label: string; about: string; placeholder: string }>;

/** Rules that expose nothing. */
export function emptyRules(): McpRules {
  return { include: {}, exclude: {} };
}

/** How many entries a selector has. */
export function selectorSize(selector: McpSelector): number {
  return SELECTOR_PARTS.reduce((n, part) => n + (selector[part]?.length ?? 0), 0);
}

/** One entry of a part as the editor shows it (a chip's text). */
export function entryText(part: SelectorPart, selector: McpSelector): string[] {
  switch (part) {
    case 'systems': return [...(selector.systems ?? [])];
    case 'types': return [...(selector.types ?? [])];
    case 'context': return [...(selector.context ?? [])];
    case 'fns': return (selector.fns ?? []).map(fnMatchText);
    case 'resources': return (selector.resources ?? []).map((r) => (r.system === undefined ? r.uri : `${r.uri} on ${r.system}${r.instance === undefined ? '' : `@${r.instance}`}`));
  }
}

/** A fn matcher as text: its name or glob, its tags as `#tag`, its system and kind as `system:` and `kind:`. */
function fnMatchText(match: FnMatch): string {
  return [
    match.fn, ...(match.tags ?? []).map((tag) => `#${tag}`),
    match.system === undefined ? undefined : `system:${match.system}`, match.kind === undefined ? undefined : `kind:${match.kind}`,
    match.when === undefined ? undefined : '(with a condition)',
  ].filter((part) => part !== undefined).join(' ');
}

/** What reading an entry's text came to. */
export type EntryRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/** Read a fn matcher from text: `fs/read`, `fs/*`, `#read`, `fs/* #write`, `system:fs`. */
export function readFnMatch(text: string): EntryRead<FnMatch> {
  const words = text.trim().split(/\s+/).filter((w) => w !== '');
  const tags = words.filter((w) => w.startsWith('#')).map((w) => w.slice(1)).filter((w) => w !== '');
  const system = words.find((w) => w.startsWith('system:'))?.slice('system:'.length);
  const kind = words.find((w) => w.startsWith('kind:'))?.slice('kind:'.length);
  const fn = words.find((w) => !w.startsWith('#') && !w.startsWith('system:') && !w.startsWith('kind:'));
  const parsed = FnMatch.safeParse({ ...(fn === undefined ? {} : { fn }), ...(tags.length === 0 ? {} : { tags }), ...(system === undefined ? {} : { system }), ...(kind === undefined ? {} : { kind }) });
  if (!parsed.success || words.length === 0) { return { ok: false, problem: 'Write a fn name or glob (fs/*), a #tag, or system:name.' }; }
  return { ok: true, value: parsed.data };
}

/** Read a resource selector from text: `file://` or `file:// on fs@laptop`. */
export function readResourceSelector(text: string): EntryRead<ResourceSelector> {
  const match = /^(\S+)(?:\s+on\s+([a-z][a-z0-9-]*)(?:@([a-z][a-z0-9-]*))?)?$/.exec(text.trim());
  const parsed = match === null ? undefined : ResourceSelector.safeParse({ uri: match[1], ...(match[2] === undefined ? {} : { system: match[2] }), ...(match[3] === undefined ? {} : { instance: match[3] }) });
  return parsed?.success === true ? { ok: true, value: parsed.data } : { ok: false, problem: 'Write a URI prefix, optionally "on system@instance".' };
}

/** A selector with one entry added to a part, or why the text isn't one. */
export function addEntry(selector: McpSelector, part: SelectorPart, text: string): EntryRead<McpSelector> {
  const trimmed = text.trim();
  if (trimmed === '') { return { ok: false, problem: 'Write something to add.' }; }
  switch (part) {
    case 'systems': {
      const parsed = SystemName.safeParse(trimmed);
      if (!parsed.success) { return { ok: false, problem: 'A system name is lowercase letters, digits and dashes.' }; }
      return { ok: true, value: { ...selector, systems: unique([...(selector.systems ?? []), parsed.data]) } };
    }
    case 'types': case 'context': {
      const parsed = NameGlob.safeParse(trimmed);
      if (!parsed.success) { return { ok: false, problem: 'Write a qualified name or glob: system/name, system/*.' }; }
      return { ok: true, value: { ...selector, [part]: unique([...(selector[part] ?? []), parsed.data]) } };
    }
    case 'fns': {
      const read = readFnMatch(trimmed);
      return read.ok ? { ok: true, value: { ...selector, fns: [...(selector.fns ?? []), read.value] } } : read;
    }
    case 'resources': {
      const read = readResourceSelector(trimmed);
      return read.ok ? { ok: true, value: { ...selector, resources: [...(selector.resources ?? []), read.value] } } : read;
    }
  }
}

/** A selector without the entry at `index` of a part (a part left empty is dropped). */
export function removeEntry(selector: McpSelector, part: SelectorPart, index: number): McpSelector {
  const list: readonly unknown[] = selector[part] ?? [];
  const kept = list.filter((_, i) => i !== index);
  const { [part]: _dropped, ...rest } = selector;
  return kept.length === 0 ? McpSelector.parse(rest) : McpSelector.parse({ ...rest, [part]: kept });
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** A route slug made from a name: lowercase, dashes, starting with a letter (undefined when nothing is left). */
export function slugOf(name: string): McpSlug | undefined {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 64);
  const parsed = McpSlug.safeParse(slug);
  return parsed.success ? parsed.data : undefined;
}

/** What each tool mode is, in words. */
export const TOOL_MODE_WORDS = {
  each: { label: 'One tool per fn', about: 'Every exposed fn is its own MCP tool (system_fn).' },
  static: { label: 'Static toolset', about: 'find, inspect and run over the exposed fns: a small, stable tool list.' },
} as const satisfies Record<McpToolMode, { label: string; about: string }>;

/** The placeholder a snippet shows where the secret goes when it isn't known (it is shown once). */
export const SECRET_PLACEHOLDER = '<secret>';

/** How to connect an MCP client: Claude Code's command line and a `.mcp.json`. */
export function connectSnippets(mcp: Pick<HubMcpView, 'slug' | 'url'>, secret: string = SECRET_PLACEHOLDER): { readonly claude: string; readonly json: string } {
  const header = `Authorization: Bearer ${secret}`;
  return {
    claude: `claude mcp add --transport http ${mcp.slug} ${mcp.url} --header "${header}"`,
    json: JSON.stringify({ mcpServers: { [mcp.slug]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2),
  };
}
