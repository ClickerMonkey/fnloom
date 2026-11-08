/**
 * Gin types and expressions on the wire. A gin type travels as its JSON definition (gin's `TypeDef`) and an expression
 * as gin's `ExprDef`; the receiving side rebuilds the real thing with the registry (`registry.parse` for types, the
 * engine for expressions), which checks every key. These schemas only check the outer shape, because gin itself is the
 * full check.
 */
import type { ExprDef, TypeDef } from '@aeye/gin';
import { z } from 'zod';

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` has the outer shape of a gin type definition: an object with a string `name`. */
export function isGinTypeDef(value: unknown): value is TypeDef {
  return isRecord(value) && 'name' in value && typeof value.name === 'string';
}

/** A gin type in its JSON wire form. `registry.parse` turns it back into a gin type and checks it fully. */
export const GinTypeDef = z.custom<TypeDef>(isGinTypeDef, { message: 'Expected a gin type definition ({ name, ... }).' });
export type GinTypeDef = z.infer<typeof GinTypeDef>;

/** True when `value` has the outer shape of a gin expression: an object with a string `kind`. */
export function isGinExprDef(value: unknown): value is ExprDef {
  return isRecord(value) && 'kind' in value && typeof value.kind === 'string';
}

/**
 * A gin expression in its JSON wire form (a constraint, a default, a program step). The engine parses and checks it;
 * the web's expression editor and viewer draw it.
 */
export const GinExprDef = z.custom<ExprDef>(isGinExprDef, { message: 'Expected a gin expression ({ kind, ... }).' });
export type GinExprDef = z.infer<typeof GinExprDef>;
