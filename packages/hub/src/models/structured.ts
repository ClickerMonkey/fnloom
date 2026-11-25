/**
 * Structured answers from the hub's own model calls (`LlmGateway.chat`): an `@aeye/schema` (`a`) schema becomes the
 * request's `responseFormat` (its JSON schema in the code shape, `LENIENT`, which the gateway plans for the model it
 * goes to: native structured output, or the schema in the prompt), and the answer is decoded back with the same
 * schema. One schema is the only place the answer's shape is written: prompts never spell the JSON out, and nothing
 * scrapes JSON out of free text.
 */
import { LENIENT, type Bindable } from '@aeye/schema';
import { Json, type LlmResponseFormat } from '@harness/core';

/** A request's structured output and the reader of its answer. */
export interface StructuredAnswer<T> {
  /** The request's `responseFormat`. */
  readonly responseFormat: LlmResponseFormat;
  /** The answer decoded with the schema, or `undefined` when it isn't JSON or doesn't fit. */
  read(text: string): T | undefined;
}

/** Ask for an answer of `schema`'s shape (a ref-free schema, built once at module scope). */
export function structuredAnswer<T>(schema: Bindable<T>): StructuredAnswer<T> {
  const rendered = schema.bind().render(LENIENT);
  const responseFormat: LlmResponseFormat = { schema: Json.parse(rendered.jsonSchema), strict: true };
  return {
    responseFormat,
    read(text) {
      const decoded = rendered.parseText(text);
      return decoded.ok ? decoded.value : undefined;
    },
  };
}
