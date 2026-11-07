/**
 * Gin types on the wire. A gin type travels as its JSON definition (gin's `TypeDef`); the receiving side rebuilds a
 * real gin type with `registry.parse`, which checks every key. This schema only checks the outer shape, because gin
 * itself is the full check.
 */
import type { TypeDef } from '@aeye/gin';
import { z } from 'zod';

/** True when `value` has the outer shape of a gin type definition: an object with a string `name`. */
export function isGinTypeDef(value: unknown): value is TypeDef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'name' in value && typeof value.name === 'string';
}

/** A gin type in its JSON wire form. `registry.parse` turns it back into a gin type and checks it fully. */
export const GinTypeDef = z.custom<TypeDef>(isGinTypeDef, { message: 'Expected a gin type definition ({ name, ... }).' });
export type GinTypeDef = z.infer<typeof GinTypeDef>;
