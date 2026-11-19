/**
 * Context folders and loading context. A system's `context/` folder holds markdown files, each a YAML header
 * (`ContextFileHeader`, any context metadata) and then the content. The system's build checks the folder and fails with
 * `ContextFileProblem`s; in dev it watches the folder and sends changes as runtime patches. The hub keys every item by
 * its stable `key` (`ContextDecl.name`), so a moved or renamed file updates the same record.
 */
import { z } from 'zod';
import { ContextDecl } from './manifest.ts';
import { Audience, LocalName, ModelCallId, QualifiedName } from './primitives.ts';
import { CRAWL_DEFAULTS } from './context-graph.ts';
import { FnRefusal } from './fn-block.ts';

/**
 * The YAML header of a context file: `ContextDecl` without its content (the body is the content), with `key` for its
 * name and the lists optional. A summary is required, so every item has a short form for small models. Every link
 * (`fns`, `imports`, `choices`, `links`, `parent`, `next`, `alwaysFor`) is a qualified name.
 */
export const ContextFileHeader = ContextDecl.omit({ name: true, content: true }).extend({
  key: LocalName,
  summary: z.string().min(1).max(300),
  imports: z.array(QualifiedName).default([]),
  fns: z.array(QualifiedName).default([]),
  suggestFns: z.array(QualifiedName).default([]),
  suggest: Audience.default('both'),
  visible: Audience.default('both'),
  alwaysFor: z.array(QualifiedName).default([]),
  tags: z.array(z.string()).default([]),
}).strict();
export type ContextFileHeader = z.infer<typeof ContextFileHeader>;

/** The declaration a checked context file becomes: its header, its key as the name, and its body as the content. */
export function contextDeclOf(header: ContextFileHeader, body: string): ContextDecl {
  const { key, ...rest } = header;
  return { ...rest, name: key, content: body };
}

/**
 * References in a context body that the check follows: `[text](context:fs/authoring.kinds)` and `fn:fs/read` (either
 * bare or as a link target). Group 1 is `context` or `fn`, group 2 the qualified name (never ending in a full stop).
 */
export const CONTEXT_BODY_REFERENCE = /\b(context|fn):([a-z][a-z0-9-]*\/[A-Za-z_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g;

/** Why a context folder doesn't build. */
export const CONTEXT_FILE_PROBLEMS = ['header', 'duplicate-key', 'broken-link', 'cycle', 'missing-summary'] as const;
export const ContextFileProblemCode = z.enum(CONTEXT_FILE_PROBLEMS);
export type ContextFileProblemCode = z.infer<typeof ContextFileProblemCode>;

/** One problem, at a file and line (1-based), as the build prints it: `context/kinds.md:3:1 broken-link …`. */
export const ContextFileProblem = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  code: ContextFileProblemCode,
  message: z.string().min(1),
});
export type ContextFileProblem = z.infer<typeof ContextFileProblem>;

/**
 * What `hub/load_context` did: the context it loaded (with what each loads with it, every time), the fns that context
 * brings that went into the session's tools, the fns it brings that could not (`fnsRefused`, each with what blocks it), and
 * what it refused, each with the closest names it knows. The model reads only its `cards` (`LoadCards`).
 */
export const LoadContextResult = z.object({
  loaded: z.array(QualifiedName),
  fns: z.array(QualifiedName),
  fnsRefused: z.array(FnRefusal),
  refused: z.array(z.object({ context: z.string(), reason: z.string().min(1), closest: z.array(QualifiedName) })),
  /** The result as the model reads it: the hub's XML cards (`<loaded_context>`, `<brought_fns>`, `<refused_context>`). */
  cards: z.string(),
});
export type LoadContextResult = z.infer<typeof LoadContextResult>;

/** `hub/context_crawl`'s args (see `CRAWL_DEFAULTS` for how a crawl walks the graph). */
export const ContextCrawlArgs = z.object({
  /** The context to start from, by key; a line copied as `name: description` is fine. */
  context: z.array(z.string().min(1)).min(1),
  /** What the crawl is for: each link's question is asked about it. */
  guidance: z.string().min(1).max(4000),
  /** How many levels of `choices` links to follow (0: only the starting context and what it imports). */
  maxDepth: z.number().int().min(0).max(10).default(CRAWL_DEFAULTS.maxDepth),
  /** The most link questions asked in all. */
  maxDecisions: z.number().int().min(1).max(4096).default(CRAWL_DEFAULTS.maxDecisions),
  /** The most tokens of context it gathers (starting context and imports included). */
  maxTokens: z.number().int().min(1).max(1_000_000).default(CRAWL_DEFAULTS.maxTokens),
  /** Only say what it found (keys, titles, descriptions, sizes and why), without loading it or giving its content. */
  metadataOnly: z.boolean().default(false),
});
export type ContextCrawlArgs = z.infer<typeof ContextCrawlArgs>;

/** How a crawled item was reached: asked for, imported by an item the crawl took, or a `choices` link answered yes. */
export const CRAWL_VIAS = ['start', 'import', 'choice'] as const;
export const CrawlVia = z.enum(CRAWL_VIAS);
export type CrawlVia = z.infer<typeof CrawlVia>;

/** One item a crawl took, with how and at what level it was reached; its content unless the crawl was metadata only. */
export const CrawledContext = z.object({
  name: QualifiedName,
  title: z.string().optional(),
  description: z.string(),
  /** The level it was taken at: 0 for the starting context and its imports. */
  depth: z.number().int().min(0),
  via: CrawlVia,
  /** The item whose link or import led here. */
  from: QualifiedName.optional(),
  /** For a choice: how likely the decision model said to load it. */
  probability: z.number().min(0).max(1).optional(),
  /** Its estimated size in tokens. */
  tokens: z.number().int().min(0),
  /** Its text, unless the crawl was metadata only (absent for dynamic context, which its system writes on load). */
  content: z.string().optional(),
});
export type CrawledContext = z.infer<typeof CrawledContext>;

/**
 * Why a link (or a starting item) was not taken: `declined` (the model's yes was under the threshold), `max-tokens` (it
 * did not fit what was left of the budget), `max-decisions` (no questions were left to ask about it), `max-depth` (a
 * link past the last level), `unavailable` (no item the person can load has that key), `failed` (the decide call failed).
 */
export const CRAWL_SKIPS = ['declined', 'max-tokens', 'max-decisions', 'max-depth', 'unavailable', 'failed'] as const;
export const CrawlSkipReason = z.enum(CRAWL_SKIPS);
export type CrawlSkipReason = z.infer<typeof CrawlSkipReason>;

/** A link (or a starting item) a crawl did not take, and why. */
export const CrawlSkip = z.object({
  context: z.string(),
  /** The item whose link it is; absent for a starting item. */
  from: QualifiedName.optional(),
  depth: z.number().int().min(0),
  reason: CrawlSkipReason,
  probability: z.number().min(0).max(1).optional(),
});
export type CrawlSkip = z.infer<typeof CrawlSkip>;

/**
 * Why a crawl stopped: `complete` (no link left to follow), a limit it reached (`max-depth`, `max-decisions`,
 * `max-tokens`), or `failed` (a decide call failed; what it took before is kept).
 */
export const CRAWL_STOPS = ['complete', 'max-depth', 'max-decisions', 'max-tokens', 'failed'] as const;
export const CrawlStopReason = z.enum(CRAWL_STOPS);
export type CrawlStopReason = z.infer<typeof CrawlStopReason>;

/**
 * What `hub/context_crawl` did: the items it took (`crawled`, in the order taken), those loaded into the session as
 * `hub/load_context` loads them (none when metadata only) with the fns they brought, the starting names it refused,
 * the links it skipped, why it stopped, and what it spent: the decide calls (`calls`, each a model call), the questions
 * asked and the tokens gathered. The model reads only its `cards` (`LoadCards`).
 */
export const ContextCrawlResult = LoadContextResult.extend({
  crawled: z.array(CrawledContext),
  skipped: z.array(CrawlSkip),
  stop: z.object({ reason: CrawlStopReason, detail: z.string().optional() }),
  /** The deepest level it took anything at. */
  depth: z.number().int().min(0),
  decisions: z.number().int().min(0),
  tokens: z.number().int().min(0),
  calls: z.array(ModelCallId),
  metadataOnly: z.boolean(),
});
export type ContextCrawlResult = z.infer<typeof ContextCrawlResult>;

/**
 * What `hub/load_fns` did: the fns that went into the session's tools, and the names it refused, each with what blocks
 * it. The model reads only its `cards` (`LoadCards`).
 */
export const LoadFnsResult = z.object({
  loaded: z.array(QualifiedName),
  refused: z.array(FnRefusal),
  /** The result as the model reads it: the hub's XML cards (`<loaded_fns>`, `<refused_fns>`). */
  cards: z.string(),
});
export type LoadFnsResult = z.infer<typeof LoadFnsResult>;

/**
 * A hub load's result (`hub/load_fns`, `hub/load_context`, `hub/context_crawl`) exactly: the model's tool reply is its XML `cards`, the one
 * XML every fn and context card is in, while the record keeps the names and refusals for people's views (the chat's
 * held banner). Exact, so no other fn's result is read as one.
 */
export const LoadCards = z.union([LoadFnsResult.strict(), LoadContextResult.strict(), ContextCrawlResult.strict()]);
export type LoadCards = z.infer<typeof LoadCards>;
