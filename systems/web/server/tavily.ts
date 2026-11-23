/**
 * Web search through Tavily's REST API (`POST /search`). The request and response are zod schemas here, so the
 * shaping and its tests share one source of truth; a response that doesn't fit is a `search-garbled` problem, never a
 * half-read result. Snippets are cleaned (whitespace, markdown leftovers) and cut at a word near the limit.
 */
import { clipMarked } from '@harness/core';
import { z } from 'zod';
import { SEARCH_DEPTHS, SEARCH_TOPICS, type SearchFoundValue } from '../shared/index.ts';
import type { SearchArgs, SearchProvider } from './index.ts';
import { WebProblem, isAbort, isTimeout } from './problem.ts';

/** `POST /search` request. */
export const TavilyRequest = z.object({
  query: z.string().min(1),
  search_depth: z.enum(SEARCH_DEPTHS),
  topic: z.enum(SEARCH_TOPICS),
  max_results: z.number().int().min(1),
  include_answer: z.boolean(),
  days: z.number().int().min(1).optional(),
  include_domains: z.array(z.string()).optional(),
  exclude_domains: z.array(z.string()).optional(),
});
export type TavilyRequest = z.infer<typeof TavilyRequest>;

/** One result of `POST /search`. */
export const TavilyResult = z.object({
  title: z.string().nullish(),
  url: z.string(),
  content: z.string().nullish(),
  score: z.number().nullish(),
  published_date: z.string().nullish(),
});
export type TavilyResult = z.infer<typeof TavilyResult>;

/** `POST /search` response: the parts the system reads. */
export const TavilyResponse = z.object({
  query: z.string().optional(),
  answer: z.string().nullish(),
  results: z.array(TavilyResult),
  response_time: z.union([z.number(), z.string()]).optional(),
});
export type TavilyResponse = z.infer<typeof TavilyResponse>;

/** An error body: Tavily answers `{ detail: { error } }` or `{ detail }`. */
const TavilyError = z.object({ detail: z.union([z.string(), z.object({ error: z.string() })]) });

/** How the Tavily client is set up. */
export interface TavilyOptions {
  /** `https://api.tavily.com`. */
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly timeout: number;
  /** Results when the caller asks for no number. */
  readonly limit: number;
  /** The longest snippet kept. */
  readonly snippetChars: number;
}

/** How a cut snippet says where the rest is. */
export const SNIPPET_REST = 'read the page with web/read';

/**
 * A snippet: whitespace collapsed, markdown heading and emphasis marks dropped, cut at a word boundary near `max`,
 * ending with how much was cut and where the rest is (`clipMarked`).
 */
export function cleanSnippet(text: string, max: number): string {
  const flat = text.replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clipMarked(flat, max, { atWord: true, rest: SNIPPET_REST });
}

/** The request for some search args. */
export function tavilyRequest(args: SearchArgs, defaultLimit: number): TavilyRequest {
  return TavilyRequest.parse({
    query: args.query,
    search_depth: args.depth ?? 'basic',
    topic: args.topic ?? 'general',
    max_results: args.limit ?? defaultLimit,
    include_answer: true,
    ...(args.days === undefined ? {} : { days: args.days }),
    ...(args.include === undefined || args.include.length === 0 ? {} : { include_domains: args.include }),
    ...(args.exclude === undefined || args.exclude.length === 0 ? {} : { exclude_domains: args.exclude }),
  });
}

/** A response as search results: best first, untitled results named by their URL, snippets cleaned. */
export function shapeResults(response: TavilyResponse, snippetChars: number, limit: number): SearchFoundValue {
  const results = response.results
    .filter((result) => URL.canParse(result.url))
    .map((result) => ({
      title: (result.title ?? '').trim() || result.url,
      url: result.url,
      snippet: cleanSnippet(result.content ?? '', snippetChars),
      score: Math.max(0, result.score ?? 0),
      ...(result.published_date === null || result.published_date === undefined || result.published_date === '' ? {} : { published: result.published_date }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const answer = response.answer?.trim();
  return { ...(answer === undefined || answer === '' ? {} : { answer }), results };
}

/** The problem for a refused request. */
async function refusal(response: Response): Promise<WebProblem> {
  const parsed = TavilyError.safeParse(await response.json().catch(() => undefined));
  const detail = parsed.success ? (typeof parsed.data.detail === 'string' ? parsed.data.detail : parsed.data.detail.error) : response.statusText;
  const said = `Tavily answered ${response.status}${detail === '' ? '' : `: ${detail}`}`;
  if (response.status === 401 || response.status === 403 || response.status === 432 || response.status === 433) { return new WebProblem('search-refused', said); }
  if (response.status === 429 || response.status >= 500) { return new WebProblem('search-busy', said); }
  return new WebProblem('search-invalid', said);
}

/** `SearchProvider` over Tavily. */
export class TavilySearch implements SearchProvider {
  readonly #options: TavilyOptions;

  constructor(options: TavilyOptions) {
    this.#options = options;
  }

  async search(args: SearchArgs, options: { key: string | undefined; signal?: AbortSignal }): Promise<SearchFoundValue> {
    if (options.key === undefined) {
      throw new WebProblem('no-search-key', 'No Tavily API key is set: an admin sets it in the web system\'s config, or the system\'s TAVILY_API_KEY.');
    }
    const body = tavilyRequest(args, this.#options.limit);
    const timeout = AbortSignal.timeout(this.#options.timeout);
    let response: Response;
    try {
      response = await this.#options.fetch(new URL('/search', this.#options.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.key}` },
        body: JSON.stringify(body),
        signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
      });
    } catch (error) {
      if (isAbort(error) && options.signal?.aborted === true) { throw error; }
      if (isTimeout(error)) { throw new WebProblem('search-busy', 'Tavily took too long to answer.', { cause: error }); }
      throw new WebProblem('search-busy', 'Couldn\'t reach Tavily.', { cause: error });
    }
    if (!response.ok) { throw await refusal(response); }
    const parsed = TavilyResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) { throw new WebProblem('search-garbled', `Tavily's answer wasn't a search response: ${parsed.error.issues[0]?.message ?? 'unreadable'}.`); }
    return shapeResults(parsed.data, this.#options.snippetChars, body.max_results);
  }
}
