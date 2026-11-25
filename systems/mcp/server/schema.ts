/**
 * An MCP server's JSON Schemas (a tool's input and output, an elicitation's requested form) read as gin types:
 * `@aeye/schema` reads the JSON Schema (`a.fromJSONSchema`) and the SDK's `ginOfA` reads that schema, so neither mapping
 * is written here. A schema they can't read exactly (a keyword `fromJSONSchema` reports unsupported, an external
 * `$ref`) is taken as any JSON (the server checks the value itself) and `degraded` says why.
 */
import { a, AnyType, RecordType, RefType, type AnySchema, type ImportReport } from '@aeye/schema';
import type { GinTypeDef, Json } from '@harness/core';
import { g, ginOfA, json, wireType, type GinType } from '@harness/sdk';

/** A JSON Schema read as a gin type, and why it fell back to any JSON when it did. */
export interface MappedSchema {
  readonly type: GinType;
  readonly def: GinTypeDef;
  readonly degraded?: string;
}

/** The message of a thrown value, in one line. */
function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'unreadable';
}

/** Any JSON, with why. */
function fallback(why: string): MappedSchema {
  const type = json();
  return { type, def: wireType(type), degraded: why };
}

/** The kind of schema a root is, its refs followed (`ref` when one names nothing). */
function rootKind(root: AnySchema, defs: Readonly<Record<string, AnySchema>>): string {
  let at: AnySchema | undefined = root;
  for (let hops = 0; at instanceof RefType && hops < 16; hops += 1) { const [name] = at.refNames(); at = name === undefined ? undefined : defs[name]; }
  return at === undefined || at instanceof RefType ? 'ref' : at.kind;
}

/**
 * A JSON Schema as a gin type. `object` requires an object schema (a tool's input or an elicitation's form): anything
 * else falls back. The fallback is any JSON, never a refusal: the server still checks what it gets.
 */
export function ginOfJsonSchema(schema: Json, options: { readonly object: boolean }): MappedSchema {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) { return fallback('the schema is not a JSON Schema object'); }
  try {
    const report: ImportReport = { unsupported: [] };
    const read = a.fromJSONSchema(schema, report);
    if (report.unsupported.length > 0) { return fallback(`the schema uses what can't be read: ${[...new Set(report.unsupported)].join(', ')}`); }
    const kind = rootKind(read.root, read.defs);
    if (options.object && kind !== 'object' && kind !== 'record') { return fallback(`the schema is a ${kind}, not an object`); }
    // a bare `{ "type": "object" }` (or one with `additionalProperties: true` and no properties) is any object: a
    // record of any JSON, so the tool gets whatever keys it is called with (an empty obj would refuse every key)
    const open = read.root instanceof RecordType && read.root.key === undefined && read.root.value instanceof AnyType;
    const type = open ? g.record(json()) : ginOfA(read.root, read.defs);
    return { type, def: wireType(type) };
  } catch (error) {
    return fallback(reasonOf(error));
  }
}
