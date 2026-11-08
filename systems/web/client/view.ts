/**
 * What the web cards show, worked out from their views so the components only draw: status chips, result rows, the
 * page card's facts, and "Read" from a search result, which starts a `web/read` run (its own card follows in the
 * chat). Browser-safe; state lives here, not in the components.
 */
import { RUN_STATUS_WORDS, type FnError, type RunId, type RunStatus } from '@harness/core';
import { reactive } from 'vue';
import type { ReadResultValue, SearchHitValue } from '../shared/index.ts';
import { domainOf, labelOf, redactUrl } from '../shared/urls.ts';

/** The tone of a status chip. */
export type Tone = 'busy' | 'ok' | 'bad' | 'quiet';

/** A status chip: a short label and its tone. */
export interface Chip {
  readonly label: string;
  readonly tone: Tone;
}

/** The chip for a run: its status in core's words. Every status is handled, so a new one fails to compile until it is. */
export function statusChip(status: RunStatus, error: FnError | undefined): Chip {
  const label = RUN_STATUS_WORDS[status];
  switch (status) {
    case 'running': return { label, tone: 'busy' };
    case 'awaiting-approval': case 'queued': case 'waiting': case 'paused': case 'invalid-input': case 'cancelled': case 'undone': return { label, tone: 'quiet' };
    case 'failed': return { label: error?.code === 'timeout' ? 'Timed out' : label, tone: 'bad' };
    case 'done': return { label, tone: 'ok' };
  }
}

/** One result row, ready to draw. */
export interface ResultRow {
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  /** The address shown under the title, credentials redacted and the scheme dropped. */
  readonly shown: string;
  readonly snippet: string;
  readonly published: string | undefined;
  /** The match score as a whole percentage. */
  readonly score: number;
}

/** The address as a reader sees it: no scheme, no trailing slash, credentials redacted. */
export function shownUrl(url: string): string {
  return redactUrl(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** A published date as the person's locale writes it, or the source's own words when they aren't a date. */
export function publishedLabel(published: string | undefined, locale?: string): string | undefined {
  if (published === undefined) { return undefined; }
  const time = Date.parse(published);
  if (Number.isNaN(time)) { return published; }
  // a bare date is a calendar day, not midnight UTC, so it is shown as that day wherever the reader is
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(published.trim());
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(dayOnly ? { timeZone: 'UTC' } : {}) }).format(time);
}

/** The rows of a search's results, in order. */
export function resultRows(results: readonly SearchHitValue[], locale?: string): ResultRow[] {
  return results.map((hit, index) => ({
    key: `${index}:${hit.url}`,
    title: hit.title,
    url: hit.url,
    domain: domainOf(hit.url),
    shown: shownUrl(hit.url),
    snippet: hit.snippet,
    published: publishedLabel(hit.published, locale),
    score: Math.round(Math.min(1, Math.max(0, hit.score)) * 100),
  }));
}

/** What the page card says about a read page. */
export interface PageFacts {
  readonly title: string;
  readonly domain: string;
  readonly shown: string;
  /** The page ended up somewhere other than asked. */
  readonly moved: boolean;
  readonly rendered: boolean;
  readonly truncated: boolean;
  readonly chars: number;
}

/** The page card's facts for a read (or, before it finishes, for the URL asked for). */
export function pageFacts(asked: string, result: ReadResultValue | undefined): PageFacts {
  const at = result?.finalUrl ?? asked;
  const parses = URL.canParse(at);
  return {
    title: result?.title ?? (parses ? labelOf(at) : at),
    domain: parses ? domainOf(at) : at,
    shown: parses ? shownUrl(at) : at,
    moved: result !== undefined && URL.canParse(asked) && new URL(asked).href !== new URL(result.finalUrl).href,
    rendered: result?.rendered ?? false,
    truncated: result?.truncated ?? false,
    chars: result?.text.length ?? 0,
  };
}

/** A start of a `web/read` from a card: in flight, started, or refused. */
export type StartState = { readonly phase: 'starting' } | { readonly phase: 'started'; readonly run: RunId } | { readonly phase: 'failed'; readonly message: string };

/** Starts per key (a result's URL), one in flight per key. */
export interface Starts {
  /** Each key's state, reactive. */
  readonly states: Readonly<Record<string, StartState>>;
  start(key: string, run: () => Promise<RunId>): void;
}

/** Make the starts a card uses. */
export function useStarts(): Starts {
  const states = reactive<Record<string, StartState>>({});
  return {
    states,
    start(key, run) {
      if (states[key]?.phase === 'starting') { return; }
      states[key] = { phase: 'starting' };
      run()
        .then((id) => { states[key] = { phase: 'started', run: id }; })
        .catch((problem: unknown) => { states[key] = { phase: 'failed', message: problem instanceof Error ? problem.message : 'It could not start.' }; });
    },
  };
}
