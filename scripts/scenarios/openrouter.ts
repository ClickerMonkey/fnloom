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

/** What OpenRouter answers (the parts read here). */
const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ cost: z.number().optional() }).optional(),
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
      return { text: body.choices[0]?.message.content ?? '', cost: body.usage?.cost ?? 0 };
    }
  }

  /** A JSON object matching `schema`, asked for once more (with the problem) when the first reply doesn't match. */
  async json<S extends z.ZodType>(model: string, schema: S, messages: readonly ChatTurn[]): Promise<Answered<z.infer<S>>> {
    let cost = 0;
    let asked = [...messages];
    for (let attempt = 1; ; attempt++) {
      const reply = await this.complete(model, asked);
      cost += reply.cost;
      try {
        return { value: schema.parse(jsonIn(reply.text)), cost };
      } catch (error) {
        if (attempt >= 2) { throw new Error(`the model's JSON didn't fit twice: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
        asked = [...asked, { role: 'assistant', content: reply.text }, { role: 'user', content: `That reply didn't fit the shape asked for (${error instanceof Error ? error.message.slice(0, 500) : String(error)}). Answer again with only the JSON object.` }];
      }
    }
  }
}
