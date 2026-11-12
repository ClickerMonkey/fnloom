/**
 * Structured answers from the hub's own model calls (`LlmGateway.chat`): a zod schema becomes the request's
 * `responseFormat`, which aeye delivers the way the model takes it (native structured output, or the schema in the
 * prompt), and the answer is read back against the same schema. One schema is the only place the answer's shape is
 * written: prompts never spell the JSON out, and nothing scrapes JSON out of free text.
 */
import { Json, type LlmResponseFormat } from '@harness/core';
import { z } from 'zod';

/** A request's structured output and the reader of its answer. */
export interface StructuredAnswer<T> {
  /** The request's `responseFormat`. */
  readonly responseFormat: LlmResponseFormat;
  /** The answer checked against the schema, or `undefined` when it isn't JSON or doesn't fit. */
  read(text: string): T | undefined;
}

/** Ask for an answer of `schema`'s shape. */
export function structuredAnswer<S extends z.ZodType>(schema: S): StructuredAnswer<z.output<S>> {
  const responseFormat: LlmResponseFormat = { schema: Json.parse(z.toJSONSchema(schema, { io: 'input' })), strict: true };
  return {
    responseFormat,
    read(text) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return undefined;
      }
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
  };
}
