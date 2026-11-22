/**
 * Fields only a person sets, by hand: on the web or an admin page, never through a fn call. A web endpoint's body
 * keeps them, but a hub fn that stands for the endpoint (the sdk's `toolArgsOf`) leaves them out of its args, so a
 * model is never shown them in a tool schema or a card and the hub refuses them as unknown args when one is sent
 * anyway. Mark a field where its object schema declares it (`inject: peopleOnly(InjectDecl.optional())`): the mark
 * follows it into schemas made from that one by `.extend`, `.pick`, `.omit` and `.partial`. A field a model may use in
 * part (a list of options to clear, which must not offer a people-only one) gets a narrower model form (`forModels`).
 */
import { z } from 'zod';

/** The fields marked people-only, with why a model may not set each (said nowhere a model reads). */
export const PEOPLE_ONLY = z.registry<{ readonly why: string }>();

/** Mark a field as set only by a person by hand (`PEOPLE_ONLY`); returns the same schema. */
export function peopleOnly<S extends z.ZodType>(schema: S, why: string): S {
  PEOPLE_ONLY.add(schema, { why });
  return schema;
}

/**
 * Whether a field is people-only: it, or what it wraps (an optional, default, nullable or readonly around it, as
 * `.partial()` adds), was marked with `peopleOnly`.
 */
export function isPeopleOnly(field: z.core.$ZodType): boolean {
  let at: z.core.$ZodType | undefined = field;
  while (at !== undefined) {
    if (PEOPLE_ONLY.has(at)) return true;
    at = at instanceof z.ZodOptional || at instanceof z.ZodDefault || at instanceof z.ZodPrefault || at instanceof z.ZodNullable || at instanceof z.ZodReadonly
      ? at.unwrap()
      : undefined;
  }
  return false;
}

/** The keys of an object schema's people-only fields (`isPeopleOnly`). */
export function peopleOnlyKeys(object: z.ZodObject): string[] {
  const shape: Readonly<Record<string, z.core.$ZodType>> = object.shape;
  return Object.entries(shape).filter(([, field]) => isPeopleOnly(field)).map(([key]) => key);
}

/**
 * Fields a model is shown in a narrower form than a person, each with that form: a list of option names that leaves
 * out the people-only ones, say. The sdk's `toolArgsOf` puts the model's form into a hub fn's args; the web endpoint's
 * body keeps the whole one.
 */
export const MODEL_FACING = new WeakMap<z.core.$ZodType, { readonly schema: z.core.$ZodType }>();

/** Give a field the narrower form a model is shown (`MODEL_FACING`); returns the field itself, for people. */
export function forModels<S extends z.ZodType>(field: S, schema: z.core.$ZodType): S {
  MODEL_FACING.set(field, { schema });
  return field;
}
