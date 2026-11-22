/**
 * The simulated person's and the judge's model calls, straight to OpenRouter (never through the hub, so they add
 * nothing to the hub's records or costs). Each call asks for one JSON object, checks it with a zod schema and gives
 * it back with what the call cost; a reply that doesn't parse is asked for again once, with the problem.
 */
import { z } from 'zod';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** One chat message. */
export interface ChatTurn {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * What a call cost, as OpenRouter's usage accounting (`usage: { include: true }`) reports it. `cost` is what OpenRouter
 * charged; a call it routed through the account's own provider key (BYOK, `is_byok`: OpenAI's models here, some of
 * the time) has only OpenRouter's fee there (often 0) and the provider's bill in `cost_details.upstream_inference_cost`.
 */
export const OpenRouterUsage = z.object({
  cost: z.number().nullish(),
  is_byok: z.boolean().nullish(),
  cost_details: z.object({ upstream_inference_cost: z.number().nullish() }).nullish(),
});
export type OpenRouterUsage = z.infer<typeof OpenRouterUsage>;

/** What a call cost in all (USD): OpenRouter's charge, plus the provider's bill when it went through BYOK (as aeye counts it). */
export function costOf(usage: OpenRouterUsage | null | undefined): number {
  if (usage === null || usage === undefined) { return 0; }
  return (usage.cost ?? 0) + (usage.is_byok === true ? usage.cost_details?.upstream_inference_cost ?? 0 : 0);
}

/** What OpenRouter answers (the parts read here). */
export const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: OpenRouterUsage.nullish(),
});

/** A JSON answer and what getting it cost (USD), retries included. */
export interface Answered<T> {
  readonly value: T;
  readonly cost: number;
}

/** The first JSON object in a reply (models sometimes wrap it in a code fence). */
function jsonIn(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) { throw new Error('the reply holds no JSON object'); }
  return JSON.parse(text.slice(start, end + 1));
}

/** A client of one OpenRouter key. */
export class OpenRouter {
  readonly #key: string;

  constructor(key: string) {
    this.#key = key;
  }

  /** One completion's text and cost. */
  async complete(model: string, messages: readonly ChatTurn[], signal?: AbortSignal): Promise<{ text: string; cost: number }> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json', 'x-title': 'harness scenarios' },
        body: JSON.stringify({ model, messages, response_format: { type: 'json_object' }, usage: { include: true } }),
        ...(signal === undefined ? {} : { signal }),
      });
      // rate limits and provider hiccups pass; anything else is a real problem
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await new Promise((done) => setTimeout(done, 2_000 * attempt));
        continue;
      }
      if (!response.ok) { throw new Error(`OpenRouter answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`); }
      const body = Completion.parse(await response.json());
      return { text: body.choices[0]?.message.content ?? '', cost: costOf(body.usage) };
    }
  }

  /**
   * A JSON object matching `schema`, asked for again (with the problem, read from zod's issues) while a reply doesn't
   * match, up to `tries` replies in all (default 2).
   */
  async json<S extends z.ZodType>(model: string, schema: S, messages: readonly ChatTurn[], options: { readonly tries?: number } = {}): Promise<Answered<z.infer<S>>> {
    const tries = options.tries ?? 2;
    let cost = 0;
    let asked = [...messages];
    for (let attempt = 1; ; attempt++) {
      const reply = await this.complete(model, asked);
      cost += reply.cost;
      try {
        return { value: schema.parse(jsonIn(reply.text)), cost };
      } catch (error) {
        if (attempt >= tries) { throw new Error(`the model's JSON didn't fit ${tries} times: ${problemOf(error)}`, { cause: error }); }
        asked = [...asked, { role: 'assistant', content: reply.text }, { role: 'user', content: `That reply didn't fit the shape asked for: ${problemOf(error).slice(0, 1_500)}. Answer again with the whole JSON object, every field filled, and nothing else.` }];
      }
    }
  }
}

/** What was wrong with a reply, for the model to fix: zod's issues one per line (path: message), or the error's message. */
function problemOf(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.slice(0, 12).map((issue) => `${issue.path.length === 0 ? '(the object)' : issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
