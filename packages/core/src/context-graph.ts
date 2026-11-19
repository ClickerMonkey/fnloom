/**
 * Context as a graph. A context item can come from a system's manifest (skills, guides), be written as memory, or be
 * made from a resource; whatever its origin, it links to other context, fns, types and resources with weighted
 * edges. The graph contextor walks the edges; loading an item brings what it hard-links (`imports`, `brings`).
 */
import { z } from 'zod';
import { ActorId, Audience, QualifiedName, RunId, type Same, SessionId, Timestamp } from './primitives.ts';
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
/** Every kind of origin, for filters: exactly `ContextOrigin`'s (a new one fails to compile here until listed). */
export const CONTEXT_ORIGIN_TYPES = ['system', 'memory', 'resource'] as const;
true satisfies Same<(typeof CONTEXT_ORIGIN_TYPES)[number], ContextOriginType>;

/** Who is asking to see a context item: the person, and the session they ask from (if any). */
export interface ContextViewer {
  readonly actor: ActorId;
  readonly session?: SessionId | undefined;
}

/**
 * Whether a viewer may see an item of this origin: everything but memory always; a memory only in its scope (one
 * session, one person, everyone), and always by its author. The one rule every reader of context applies.
 */
export function seesOrigin(origin: ContextOrigin | undefined, viewer: ContextViewer): boolean {
  if (origin?.type !== 'memory') return true;
  if (origin.author === viewer.actor) return true;
  switch (origin.scope.to) {
    case 'everyone': return true;
    case 'user': return origin.scope.user === viewer.actor;
    case 'session': return origin.scope.session === viewer.session;
  }
}

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
/** Every kind of item a link can point at: exactly `LinkTarget`'s (a new one fails to compile here until listed). */
export const LINK_TARGET_KINDS = ['fn', 'context', 'resource', 'type'] as const;
true satisfies Same<(typeof LINK_TARGET_KINDS)[number], LinkTargetKind>;

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
  /** For authored edges: the person who drew it. */
  by: ActorId.optional(),
  updatedAt: Timestamp,
});
export type ContextLink = z.infer<typeof ContextLink>;

// ─── Hub fn shapes (args and results; the hub contract's gin types are made from these) ───────────────────────

/**
 * The options a person-made context item takes beyond its text: the context page's Advanced section, and
 * the same as a declared item's (`ContextDecl`). Absent fields keep their defaults (or, on an edit, their values).
 */
export const ContextOptions = z.object({
  /** How much it counts when scored (0 leaves it out; 1 when absent). */
  weight: z.number().min(0).max(2).optional(),
  /** A short form shown at `signature` detail. */
  summary: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  /** Tied fns: offered whenever this item is loaded. */
  fns: z.array(QualifiedName).optional(),
  /** Fns suggested alongside it. */
  suggestFns: z.array(QualifiedName).optional(),
  /** Agent fns whose prompts always carry it. */
  alwaysFor: z.array(QualifiedName).optional(),
  /** A `/command` name that loads it. */
  command: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  /** Who sees it listed, and who it is suggested to. */
  visible: Audience.optional(),
  suggest: Audience.optional(),
  /** Its parent in a hierarchy. */
  parent: QualifiedName.optional(),
});
export type ContextOptions = z.infer<typeof ContextOptions>;

/** `hub/remember`: write a memory. */
export const RememberArgs = z.object({
  text: z.string().min(1),
  /** A short title; the name's slug comes from it (or the first words). */
  title: z.string().optional(),
  scope: z.enum(['session', 'user', 'everyone']).default('session'),
  about: z.array(LinkTarget).optional(),
}).extend(ContextOptions.shape);

/** Edit a memory: any of what `remember` takes; the scope is fixed once written. */
export const UpdateMemoryArgs = RememberArgs.omit({ scope: true }).partial().extend({
  name: QualifiedName,
  /** Options to remove; an option left out of the edit stays as it was. */
  clear: z.array(ContextOptions.keyof()).optional(),
});
export type UpdateMemoryArgs = z.infer<typeof UpdateMemoryArgs>;
export type RememberArgs = z.infer<typeof RememberArgs>;

/** `hub/context_from_resource`: make context items from a resource or chosen sections. */
export const ContextFromResourceArgs = z.object({
  uri: ResourceUri,
  /** Which sections; all of them when absent. */
  sections: z.array(SectionKey).optional(),
  copy: ContextCopy.default('live'),
}).extend(ContextOptions.omit({ summary: true, parent: true }).shape);
export type ContextFromResourceArgs = z.infer<typeof ContextFromResourceArgs>;

/** What making context from a resource did. Re-running it updates the same names, never duplicates. */
export const ContextFromResourceResult = z.object({
  created: z.array(QualifiedName),
  updated: z.array(QualifiedName),
  links: z.number().int().min(0),
});
export type ContextFromResourceResult = z.infer<typeof ContextFromResourceResult>;

// ─── Crawling context by decision (`hub/context_crawl`, plan item 7) ───────────

/**
 * How a crawl walks the graph, level by level: what a level loads brings what it imports, always (transitively, cycles
 * cut); its `choices` links are the only conditional step. Each link not yet loaded becomes one yes/no question to the
 * decision model ("Load X when: …?"), all of a level's questions asked together in calls of at most `CRAWL_BATCH_MAX`
 * (fewer when the model's `maxQuestions` says so). The links answered at or above the decide role's threshold load,
 * most likely first, while they fit the token budget; what they load is the next level. It stops at `maxDepth`,
 * `maxDecisions` or `maxTokens`, or when no link is left to follow.
 */
export const CRAWL_DEFAULTS = { maxDepth: 3, maxDecisions: 256, maxTokens: 8000 } as const;

/** Phil: at most 256 link questions go to the decision model in one call; fewer when the model takes fewer. */
export const CRAWL_BATCH_MAX = 256;

/** How many questions one decide call of a crawl asks: `CRAWL_BATCH_MAX`, or the model's own cap (`maxQuestions`) when lower. */
export function crawlBatchSize(maxQuestions: number | undefined): number {
  return maxQuestions === undefined || maxQuestions < 1 ? CRAWL_BATCH_MAX : Math.min(CRAWL_BATCH_MAX, Math.floor(maxQuestions));
}

/** What every decide call of a crawl reads: the caller's guidance, once per call rather than in every question. */
export function crawlInput(guidance: string): string {
  return `Guidance: ${guidance.trim()}`;
}

/** The item a `choices` link leads to, as its question names it. */
export interface CrawlTarget {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description: string;
}

/** The yes/no question for one `choices` link: the item it leads to (its title and first line) and the link's condition. */
export function crawlQuestion(to: CrawlTarget, when: string): string {
  const about = to.description.split('\n', 1)[0]?.trim() ?? '';
  const label = to.title === undefined || to.title === '' ? to.name : `${to.title} [${to.name}]`;
  return `Load ${label}${about === '' ? '' : ` (${about})`} when: ${when.trim()}?`;
}

/** One link's answer: how likely the model said yes. */
export interface CrawlAnswer<T> {
  readonly link: T;
  readonly probability: number;
}

/**
 * A level's answers split by the threshold: the links answered yes (at or above it), most likely first (ties keep their
 * order), and the rest in their order.
 */
export function rankCrawlAnswers<T>(answers: readonly CrawlAnswer<T>[], threshold: number): { readonly yes: CrawlAnswer<T>[]; readonly no: CrawlAnswer<T>[] } {
  const yes = answers.filter((answer) => answer.probability >= threshold);
  return {
    yes: yes.map((answer, index) => ({ answer, index })).sort((a, b) => b.answer.probability - a.answer.probability || a.index - b.index).map(({ answer }) => answer),
    no: answers.filter((answer) => answer.probability < threshold),
  };
}
