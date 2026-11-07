/** Small type and runtime helpers the SDK's builders share. Internal: not exported from the package. */

/** Flattens an intersection into one object type, so hovers read as a plain shape. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** True when `A` and `B` are the same type (used by the compile-time tests). */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** A compile-time assertion: `expectType<Equal<A, B>>(true)` fails to compile unless the types are equal. */
export const expectType = <T extends true>(_proof: T): void => undefined;

/**
 * The value of an optional builder input whose type parameter defaults to the type of `fallback`. A builder like
 * `fn()` declares `D extends Deps = {}`: when the author leaves `deps` out, TypeScript infers `D` as `{}` and the
 * fallback `{}` is exactly that type. TypeScript can't see this inside the generic body, so this one helper states
 * it; every builder default goes through here and nowhere else casts. The fallback must be of a type `T` narrows
 * (`T extends F`), so a fallback of an unrelated type (`orDefault(deps, 42)`) does not compile.
 */
export function orDefault<T extends F, F>(value: T | undefined, fallback: F): T {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see the doc comment: T is the fallback's type whenever value is absent
  return value === undefined ? (fallback as T) : value;
}

/** Map an object's values, keeping its keys. */
export function mapValues<O extends Record<string, unknown>, R>(object: O, map: (value: O[keyof O], key: keyof O & string) => R): { [K in keyof O]: R } {
  const out = Object.fromEntries(entriesOf(object).map(([key, value]) => [key, map(value, key)]));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every key of `object` was mapped above
  return out as { [K in keyof O]: R };
}

/** The entries of a record, typed by its keys. */
export function entriesOf<O extends Record<string, unknown>>(object: O): Array<[keyof O & string, O[keyof O]]> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the keys come from the object itself
  return Object.keys(object).map((key) => [key, object[key as keyof O & string]]);
}
