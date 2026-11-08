/**
 * Making a mock fixture: the literal is typed by its schema's input (`z.input<S>`), so a field the schema gains, loses
 * or renames breaks the mock at compile time, not at its first call; it is then parsed, so defaults and brands apply.
 * Every mock record goes through this; none is a loose object.
 */
import type { z } from 'zod';

/** Parse `input`, which must already be the schema's input type. */
export function fixture<S extends z.ZodType>(schema: S, input: z.input<S>): z.output<S> {
  return schema.parse(input);
}
