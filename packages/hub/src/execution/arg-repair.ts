/**
 * Args read the way their sender meant them: the one place the hub forgives a call's shape before it checks it. Some
 * models double-encode a nested arg, sending an object or a list as a string holding its JSON
 * (`{"args": "{\"status\": \"paid\"}"}`). Where a fn's args schema expects an object or a list and the call has a
 * string that parses as JSON of that shape, the JSON is taken instead, and the run records the repair
 * (`Run.repairs`) rather than settling as invalid input. Args that already fit are never touched, nor is a string
 * where the schema takes text (or any JSON): a text field holding JSON is that text.
 */
import { Json, type ArgRepair } from '@harness/core';
import { z } from 'zod';

/** A call's args as the hub reads them, and what it repaired to get there (empty when they were taken as sent). */
export interface RepairedArgs {
  readonly args: Json;
  readonly repairs: readonly ArgRepair[];
}

/** Args against a fn's args schema, with each object or list sent as a string holding its JSON read as that JSON. */
export function repairArgs(schema: z.ZodType, args: Json): RepairedArgs {
  if (schema.safeParse(args).success) return { args, repairs: [] };
  const repairs: ArgRepair[] = [];
  const repaired = repairValue(schema, args, [], repairs);
  return repairs.length === 0 ? { args, repairs } : { args: Json.parse(repaired), repairs };
}

/** What a schema stands for once its wrappers (optional, default, nullable, readonly, catch, lazy, a pipe's input) are taken off. */
function unwrapped(schema: z.core.$ZodType): z.core.$ZodType {
  let at = schema;
  for (;;) {
    if (at instanceof z.ZodOptional || at instanceof z.ZodNullable || at instanceof z.ZodDefault || at instanceof z.ZodPrefault
      || at instanceof z.ZodReadonly || at instanceof z.ZodCatch || at instanceof z.ZodNonOptional || at instanceof z.ZodLazy) {
      at = at.unwrap();
    } else if (at instanceof z.ZodPipe) {
      at = at.in;
    } else {
      return at;
    }
  }
}

/** The shape a schema wants in place of a string: an object, a list, or none (text, any JSON, a number, …). */
function structureOf(schema: z.core.$ZodType): 'object' | 'list' | undefined {
  if (schema instanceof z.ZodObject || schema instanceof z.ZodRecord) return 'object';
  if (schema instanceof z.ZodArray || schema instanceof z.ZodTuple) return 'list';
  return undefined;
}

/** Whether a value is a JSON object (not null, not a list). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string's JSON when it holds an object or a list; undefined for anything else (plain text, a number, broken JSON). */
function decoded(text: string): unknown {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `value` with its double-encoded parts under `schema` decoded, each noted in `repairs` at its dotted path. */
function repairValue(schema: z.core.$ZodType, value: unknown, path: readonly string[], repairs: ArgRepair[]): unknown {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodUnion) return repairUnion(inner, value, path, repairs);
  if (typeof value === 'string') {
    const wanted = structureOf(inner);
    const json = wanted === undefined ? undefined : decoded(value);
    if (wanted === 'object' ? !isObject(json) : wanted !== 'list' || !Array.isArray(json)) return value;
    repairs.push({ path: path.join('.'), repair: 'json-string' });
    return repairValue(inner, json, path, repairs);
  }
  if (inner instanceof z.ZodObject && isObject(value)) {
    const shape: Readonly<Record<string, z.core.$ZodType | undefined>> = inner.shape;
    return Object.fromEntries(Object.entries(value).map(([key, field]) => {
      const fieldSchema = shape[key];
      return [key, fieldSchema === undefined ? field : repairValue(fieldSchema, field, [...path, key], repairs)];
    }));
  }
  if (inner instanceof z.ZodRecord && isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, repairValue(inner.valueType, field, [...path, key], repairs)]));
  }
  if (inner instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item, at) => repairValue(inner.element, item, [...path, String(at)], repairs));
  }
  return value;
}

/**
 * A union's value: as it is when it fits a member already (a text member takes the string as text), else the first
 * member it fits once repaired; unchanged when it fits none either way.
 */
function repairUnion(union: z.ZodUnion, value: unknown, path: readonly string[], repairs: ArgRepair[]): unknown {
  if (union.safeParse(value).success) return value;
  for (const option of union.options) {
    const tried: ArgRepair[] = [];
    const repaired = repairValue(option, value, path, tried);
    if (tried.length > 0 && z.safeParse(option, repaired).success) {
      repairs.push(...tried);
      return repaired;
    }
  }
  return value;
}
