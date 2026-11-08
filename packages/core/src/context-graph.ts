/**
 * Context as a graph. A context item can come from a system's manifest (skills, guides), be written as memory, or be
 * made from a resource; whatever its origin, it links to other context, fns, types and resources with weighted
 * edges. The graph contextor walks the edges; loading an item brings what it hard-links (`imports`, `brings`).
 */
import { z } from 'zod';
import { ActorId, QualifiedName, RunId, SessionId, Timestamp } from './primitives.ts';
import { ResourceUri, SectionKey } from './resources.ts';

// ─── Where context comes from ─────────────────────────────────────────────────

/** Who a memory is for: one session, one person, or everyone. */
export const MemoryScope = z.discriminatedUnion('to', [
  z.object({ to: z.literal('session'), session: SessionId }),
  z.object({ to: z.literal('user'), user: ActorId }),
  z.object({ to: z.literal('everyone') }),
]);
export type MemoryScope = z.infer<typeof MemoryScope>;

/**
 * How a resource-made item reads its text: `live` reads the source section's current text when loaded (never stale);
 * `snapshot` keeps a copy and turns stale when the section changes.
 */
export const CONTEXT_COPIES = ['live', 'snapshot'] as const;
export const ContextCopy = z.enum(CONTEXT_COPIES);
export type ContextCopy = z.infer<typeof ContextCopy>;

/** Where a context item came from. */
export const ContextOrigin = z.discriminatedUnion('type', [
  /** Declared in a system's manifest (skills, guides, `/commands`). */
  z.object({ type: z.literal('system') }),
  /** Written by a person or an agent (`hub/remember`), for a scope. Named `memory/<slug>-<hash>`. */
  z.object({ type: z.literal('memory'), scope: MemoryScope, author: ActorId, run: RunId.optional() }),
  /** Made from a resource or one of its sections (`hub/context_from_resource`). Named `resource/<slug>-<hash>`. */
  z.object({ type: z.literal('resource'), uri: ResourceUri, section: SectionKey.optional(), version: z.string(), copy: ContextCopy }),
]);
export type ContextOrigin = z.infer<typeof ContextOrigin>;
export type ContextOriginType = ContextOrigin['type'];

/** Estimated tokens of an item's full content and of its summary, kept current on write so selection never tokenizes. */
export const ContextTokens = z.object({ full: z.number().int().min(0), summary: z.number().int().min(0) });
export type ContextTokens = z.infer<typeof ContextTokens>;

// ─── Links ────────────────────────────────────────────────────────────────────

/**
 * What an edge means. Hard links travel with their item (`imports`: context it brings; `brings`: fns it adds when
 * loaded). Soft links only spread activation: `suggests` (a fn worth offering), `parent` / `next` (a hierarchy, and
 * a chain of pieces of one long text), `related`, `mentions` (found in the text), `about` (what a memory or a
 * resource context is about), `learned` (used together in one turn).
 */
export const LINK_RELATIONS = ['imports', 'brings', 'suggests', 'parent', 'next', 'related', 'mentions', 'about', 'learned'] as const;
export const LinkRelation = z.enum(LINK_RELATIONS);
export type LinkRelation = z.infer<typeof LinkRelation>;

/** The relations that make two items travel together. */
export const HARD_RELATIONS = ['imports', 'brings'] as const satisfies readonly LinkRelation[];

/** The relations a system or a person may declare; `mentions` and `learned` are the hub's to find. */
export const DECLARABLE_RELATIONS = ['imports', 'brings', 'suggests', 'parent', 'next', 'related', 'about'] as const satisfies readonly LinkRelation[];
export const DeclarableRelation = z.enum(DECLARABLE_RELATIONS);
export type DeclarableRelation = z.infer<typeof DeclarableRelation>;

/** What an edge points at. */
export const LinkTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), name: QualifiedName }),
  z.object({ kind: z.literal('fn'), name: QualifiedName }),
  z.object({ kind: z.literal('type'), name: QualifiedName }),
  z.object({ kind: z.literal('resource'), uri: ResourceUri, section: SectionKey.optional() }),
]);
export type LinkTarget = z.infer<typeof LinkTarget>;
export type LinkTargetKind = LinkTarget['kind'];

/** The stored key of a link target: `context:fs/guide`, `resource:file:///a.md#Usage`. */
export function linkTargetKey(target: LinkTarget): string {
  switch (target.kind) {
    case 'context': case 'fn': case 'type': return `${target.kind}:${target.name}`;
    case 'resource': return target.section === undefined ? `resource:${target.uri}` : `resource:${target.uri}#${target.section}`;
  }
}

/** A link a system or person declares on a context item (`ContextDecl.links`). */
export const DeclaredLink = z.object({ to: LinkTarget, relation: DeclarableRelation, weight: z.number().min(0).max(1).default(0.5) });
export type DeclaredLink = z.infer<typeof DeclaredLink>;

/**
 * Where an edge came from. `declared` and `mentioned` edges are derived from their item's record and rewritten with
 * it, so they never drift; `resource` edges are written when context is made from a resource; `learned` edges are
 * kept and decay; `authored` edges are drawn by a person.
 */
export const LINK_SOURCES = ['declared', 'mentioned', 'resource', 'learned', 'authored'] as const;
export const LinkSource = z.enum(LINK_SOURCES);
export type LinkSource = z.infer<typeof LinkSource>;

/** One directed edge, as the hub keeps it. `from` is a context item's or a fn's name. */
export const ContextLink = z.object({
  from: QualifiedName,
  to: LinkTarget,
  /** `linkTargetKey(to)`, the stored key's second part. */
  toKey: z.string(),
  relation: LinkRelation,
  weight: z.number().min(0).max(1),
  source: LinkSource,
  /** For learned edges: how many turns used both ends (decays by half every `HARNESS_LINK_HALF_LIFE`). */
  uses: z.number().min(0).optional(),
  updatedAt: Timestamp,
});
export type ContextLink = z.infer<typeof ContextLink>;

// ─── Hub fn shapes (args and results; the hub contract's gin types are made from these) ───────────────────────

/** `hub/remember`: write a memory. */
export const RememberArgs = z.object({
  text: z.string().min(1),
  /** A short title; the name's slug comes from it (or the first words). */
  title: z.string().optional(),
  scope: z.enum(['session', 'user', 'everyone']).default('session'),
  about: z.array(LinkTarget).optional(),
  weight: z.number().min(0).max(2).optional(),
});
export type RememberArgs = z.infer<typeof RememberArgs>;

/** `hub/context_from_resource`: make context items from a resource or chosen sections. */
export const ContextFromResourceArgs = z.object({
  uri: ResourceUri,
  /** Which sections; all of them when absent. */
  sections: z.array(SectionKey).optional(),
  copy: ContextCopy.default('live'),
  weight: z.number().min(0).max(2).optional(),
  /** Agent fns whose prompts always carry the made context. */
  alwaysFor: z.array(QualifiedName).optional(),
  /** A `/command` name that loads the resource-level item. */
  command: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
});
export type ContextFromResourceArgs = z.infer<typeof ContextFromResourceArgs>;

/** What making context from a resource did. Re-running it updates the same names, never duplicates. */
export const ContextFromResourceResult = z.object({
  created: z.array(QualifiedName),
  updated: z.array(QualifiedName),
  links: z.number().int().min(0),
});
export type ContextFromResourceResult = z.infer<typeof ContextFromResourceResult>;
