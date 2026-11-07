/**
 * Object helpers every package shares. With `exactOptionalPropertyTypes`, an optional field may be left out but not
 * set to `undefined`, while zod infers optional fields as `?: T | undefined`; `compact` is the one way a value of the
 * second shape becomes the first, so no mapper repeats a hand-written spread per optional field.
 */

/** An object without its `undefined` fields, typed so: `?: T | undefined` (as zod infers) becomes `?: T`. */
export type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/** Drop the `undefined` fields of an object, so it fits a type whose optional fields don't take `undefined`. */
export function compact<T extends object>(value: T): Compact<T> {
  const kept = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- exactly the fields of `value` that aren't undefined
  return kept as Compact<T>;
}
