/**
 * An MCP server's JSON Schemas (a tool's input and output, an elicitation's requested form) read as gin types: zod
 * reads the JSON Schema (`z.fromJSONSchema`) and the SDK's `ginOf` reads that zod schema, so neither mapping is written
 * here. A schema neither can read is taken as any JSON (the server checks the value itself) and `degraded` says why.
 */
import type { GinTypeDef, Json } from '@harness/core';
import { ginOf, json, wireType, type GinType } from '@harness/sdk';
import { z } from 'zod';

/** A JSON Schema read as a gin type, and why it fell back to any JSON when it did. */
export interface MappedSchema {
  readonly type: GinType;
  readonly def: GinTypeDef;
  readonly degraded?: string;
}

/** The outer shape of a JSON Schema object; zod's `fromJSONSchema` checks the rest. */
const JsonSchemaObject = z.custom<z.core.JSONSchema.JSONSchema>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), {
  message: 'Expected a JSON Schema object.',
});

/** What zod's message for a thrown value is, in one line. */
function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'unreadable';
}

/** Any JSON, with why. */
function fallback(why: string): MappedSchema {
  const type = json();
  return { type, def: wireType(type), degraded: why };
}

/**
 * A JSON Schema as a gin type. `object` requires an object schema (a tool's input or an elicitation's form): anything
 * else falls back. The fallback is any JSON, never a refusal: the server still checks what it gets.
 */
export function ginOfJsonSchema(schema: Json, options: { readonly object: boolean }): MappedSchema {
  const parsed = JsonSchemaObject.safeParse(schema);
  if (!parsed.success) { return fallback('the schema is not a JSON Schema object'); }
  try {
    const read = z.fromJSONSchema(parsed.data);
    if (options.object && read._zod.def.type !== 'object') { return fallback(`the schema is a ${read._zod.def.type}, not an object`); }
    const type = ginOf(read);
    return { type, def: wireType(type) };
  } catch (error) {
    return fallback(reasonOf(error));
  }
}
