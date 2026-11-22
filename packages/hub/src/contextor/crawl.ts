/**
 * `hub/ctx_crawl`'s walk (plan item 7): from starting context, level by level, imports always and `choices` links by
 * decision. Each level's unloaded links become one yes/no question each, asked together through the hub's decider (the
 * `decide` role's model, split into calls of at most `crawlBatchSize` questions, each recorded as a model call); the
 * links answered at or above the role's threshold load, most likely first, with their imports, while they fit the token
 * budget. Core's `context-graph.ts` holds the wording and the ranking; this walks the catalog. Loading what it took into
 * a session, and the cards the model reads, are the hub fn's (`boot/hub-fns.ts`).
 */
import {
  QualifiedName, crawlBatchSize, crawlInput, crawlQuestion, rankCrawlAnswers, yesProbability, type ContextChoice, type ContextCrawlArgs, type ContextRecord, type CrawledContext,
  type CrawlSkip, type CrawlStopReason, type DecisionAnswer, type DecisionQuestion, type ModelCallId,
} from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { Decider, DecisionModel, ModelSite } from '../models/index.ts';
import { withImports } from './brought.ts';
import { contextTokens } from './tokens.ts';

/** What a crawl reads: the catalog's context, the decider, and which items the asker may load. */
export interface CrawlDeps {
  readonly catalog: Pick<Catalog, 'context'>;
  readonly decider: Pick<Decider, 'ask'>;
  /** Whether the asker may load this item now (switched on, a system the session uses, visible to the person). */
  readonly usable: (record: ContextRecord) => Promise<boolean>;
}

/** One crawl: the starting names (already checked), the args' limits and guidance, the model, and who pays. */
export interface CrawlPlan extends Pick<ContextCrawlArgs, 'guidance' | 'maxDepth' | 'maxDecisions' | 'maxTokens'> {
  readonly start: readonly QualifiedName[];
  readonly model: DecisionModel;
  readonly site: ModelSite;
  readonly signal: AbortSignal;
}

/** An item a crawl took, with its record (for loading it and for its content). */
export interface Taken extends Omit<CrawledContext, 'content'> {
  readonly record: ContextRecord;
}

/** What a crawl found and spent, and why it stopped. */
export interface CrawlOutcome {
  readonly taken: readonly Taken[];
  readonly skipped: readonly CrawlSkip[];
  readonly stop: { readonly reason: CrawlStopReason; readonly detail?: string };
  readonly depth: number;
  readonly decisions: number;
  readonly tokens: number;
  readonly calls: readonly ModelCallId[];
}

/** One `choices` link of an item the crawl took, with the item it leads to. */
interface Link {
  readonly from: QualifiedName;
  readonly choice: ContextChoice;
  readonly target: ContextRecord;
}

/** What taking an item (with its imports) came to. */
type Admitted = { readonly taken: readonly Taken[] } | { readonly over: true };

/** An item's size as a crawl counts it: its full text, or its summary while its text is written on load (dynamic context). */
export function crawlTokens(record: Pick<ContextRecord, 'decl' | 'tokens'>): number {
  const tokens = record.tokens ?? contextTokens(record.decl);
  return record.decl.content === undefined ? tokens.summary : tokens.full;
}

/** Walks the context graph for one crawl. */
export class ContextCrawler {
  readonly #deps: CrawlDeps;

  constructor(deps: CrawlDeps) {
    this.#deps = deps;
  }

  async crawl(plan: CrawlPlan): Promise<CrawlOutcome> {
    const run = new CrawlRun(this.#deps, plan);
    return run.walk();
  }
}

/** The state of one crawl as it walks. */
class CrawlRun {
  readonly #deps: CrawlDeps;
  readonly #plan: CrawlPlan;
  readonly #taken: Taken[] = [];
  readonly #names = new Set<string>();
  readonly #skipped: CrawlSkip[] = [];
  readonly #calls: ModelCallId[] = [];
  #tokens = 0;
  #decisions = 0;

  constructor(deps: CrawlDeps, plan: CrawlPlan) {
    this.#deps = deps;
    this.#plan = plan;
  }

  async walk(): Promise<CrawlOutcome> {
    let over = false;
    let frontier: Taken[] = [];
    // level 0: what was asked for, each with what it imports
    for (const name of this.#plan.start) {
      if (this.#names.has(name)) continue;
      const record = await this.#deps.catalog.context(name);
      if (record === undefined) continue;
      const admitted = await this.#admit(record, { depth: 0, via: 'start' });
      if ('over' in admitted) { over = true; this.#skipped.push({ context: name, depth: 0, reason: 'max-tokens' }); } else { frontier.push(...admitted.taken); }
    }
    if (over) return this.#outcome('max-tokens');
    for (let depth = 1; ; depth += 1) {
      const links = await this.#links(frontier, depth);
      if (links.length === 0) return this.#outcome('complete');
      if (depth > this.#plan.maxDepth) {
        for (const link of links) this.#skip(link, depth, 'max-depth');
        return this.#outcome('max-depth');
      }
      // one question per link, as many as are left to ask; the rest are out of questions
      const left = this.#plan.maxDecisions - this.#decisions;
      const asked = links.slice(0, left);
      for (const link of links.slice(left)) this.#skip(link, depth, 'max-decisions');
      let answers: Readonly<Record<string, DecisionAnswer>>;
      try {
        answers = await this.#ask(asked);
      } catch (error) {
        // a cancelled run is not a failed crawl: nothing is reported or loaded for it
        if (this.#plan.signal.aborted) throw error;
        for (const link of asked) this.#skip(link, depth, 'failed');
        return this.#outcome('failed', error instanceof Error ? error.message : String(error));
      }
      const { yes, no } = rankCrawlAnswers(asked.map((link, index) => ({ link, probability: yesProbability(answers[questionKey(index)]) })), this.#plan.model.threshold);
      for (const { link, probability } of no) this.#skip(link, depth, 'declined', probability);
      const next: Taken[] = [];
      for (const { link, probability } of yes) {
        // two links to one item: the first taken wins, the other has nothing left to load
        if (this.#names.has(link.target.name)) continue;
        const admitted = await this.#admit(link.target, { depth, via: 'choice', from: link.from, probability });
        if ('over' in admitted) { over = true; this.#skip(link, depth, 'max-tokens', probability); } else { next.push(...admitted.taken); }
      }
      if (over) return this.#outcome('max-tokens');
      if (links.length > asked.length) return this.#outcome('max-decisions');
      if (next.length === 0) return this.#outcome('complete');
      frontier = next;
    }
  }

  /** Ask the decision model about each link, in calls of at most `crawlBatchSize` questions; the answers by question key. */
  async #ask(links: readonly Link[]): Promise<Readonly<Record<string, DecisionAnswer>>> {
    if (links.length === 0) return {};
    const questions: Record<string, DecisionQuestion> = Object.fromEntries(links.map((link, index) => [
      questionKey(index), { type: 'predicate', instructions: crawlQuestion({ name: link.target.name, title: link.target.decl.title, description: link.target.decl.description }, link.choice.when) },
    ]));
    const { model, guidance, site, signal } = this.#plan;
    this.#decisions += links.length;
    const decided = await this.#deps.decider.ask({ input: crawlInput(guidance), questions, model: { ...model, maxQuestions: crawlBatchSize(model.maxQuestions) }, site, signal });
    this.#calls.push(...decided.calls);
    return decided.answers;
  }

  /**
   * The `choices` links of what the last level took, to items not taken yet, each once per (from, to); a link to an item
   * the asker can't load is skipped as `unavailable` without a question.
   */
  async #links(frontier: readonly Taken[], depth: number): Promise<Link[]> {
    const links: Link[] = [];
    const seen = new Set<string>();
    for (const item of frontier) {
      for (const choice of item.record.decl.choices ?? []) {
        const key = `${item.name}\n${choice.to}`;
        if (this.#names.has(choice.to) || seen.has(key)) continue;
        seen.add(key);
        const target = await this.#deps.catalog.context(choice.to);
        if (target === undefined || !await this.#deps.usable(target)) {
          this.#skipped.push({ context: choice.to, from: item.name, depth, reason: 'unavailable' });
          continue;
        }
        links.push({ from: item.name, choice, target });
      }
    }
    return links;
  }

  /**
   * Take an item with what it imports (transitively, those not taken yet that the asker may load), all or nothing:
   * when they don't fit what is left of the token budget, none is taken.
   */
  async #admit(record: ContextRecord, how: Pick<Taken, 'depth' | 'via'> & Partial<Pick<Taken, 'from' | 'probability'>>): Promise<Admitted> {
    const unit: ContextRecord[] = [];
    for (const name of await withImports(this.#deps.catalog, [record.name])) {
      if (this.#names.has(name)) continue;
      const parsed = QualifiedName.safeParse(name);
      const found = name === record.name ? record : parsed.success ? await this.#deps.catalog.context(parsed.data) : undefined;
      if (found !== undefined && await this.#deps.usable(found)) unit.push(found);
    }
    const cost = unit.reduce((sum, item) => sum + crawlTokens(item), 0);
    if (this.#tokens + cost > this.#plan.maxTokens) return { over: true };
    this.#tokens += cost;
    const taken = unit.map((item): Taken => {
      this.#names.add(item.name);
      const head = item.name === record.name;
      return {
        name: item.name, ...(item.decl.title === undefined ? {} : { title: item.decl.title }), description: item.decl.description, depth: how.depth,
        via: head ? how.via : 'import', ...(head ? pick(how) : { from: record.name }), tokens: crawlTokens(item), record: item,
      };
    });
    this.#taken.push(...taken);
    return { taken };
  }

  #skip(link: Link, depth: number, reason: CrawlSkip['reason'], probability?: number): void {
    this.#skipped.push({ context: link.target.name, from: link.from, depth, reason, ...(probability === undefined ? {} : { probability }) });
  }

  #outcome(reason: CrawlStopReason, detail?: string): CrawlOutcome {
    return {
      taken: this.#taken, skipped: this.#skipped, stop: { reason, ...(detail === undefined ? {} : { detail }) },
      depth: this.#taken.reduce((deepest, item) => Math.max(deepest, item.depth), 0), decisions: this.#decisions, tokens: this.#tokens, calls: this.#calls,
    };
  }
}

/** A link's question key in a level's decide call. */
function questionKey(index: number): string {
  return `link${index}`;
}

/** The `from` and `probability` of how an item was reached, when given. */
function pick(how: Partial<Pick<Taken, 'from' | 'probability'>>): Partial<Pick<Taken, 'from' | 'probability'>> {
  return { ...(how.from === undefined ? {} : { from: how.from }), ...(how.probability === undefined ? {} : { probability: how.probability }) };
}
