/**
 * A ref kept in browser storage (per device): read once through its zod schema, written back on every change. A
 * stored value that no longer matches the schema, or isn't JSON, is ignored and the fallback used.
 */
import { shallowRef, watch, type Ref } from 'vue';
import type { z } from 'zod';

/** The part of `Storage` a persisted ref uses, so tests can pass a map. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Read a stored value through its schema. */
export function readStored<S extends z.ZodType>(store: KeyValueStore, key: string, schema: S): z.output<S> | undefined {
  const raw = store.getItem(key);
  if (raw === null) { return undefined; }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A ref saved under `key`; replace its value to save (it is shallow). Setting it to `undefined` removes the key. */
export function persisted<S extends z.ZodType>(store: KeyValueStore, key: string, schema: S, fallback: z.output<S>): Ref<z.output<S>> {
  const value: Ref<z.output<S>> = shallowRef(readStored(store, key, schema) ?? fallback);
  watch(value, (now) => {
    if (now === undefined) { store.removeItem(key); } else { store.setItem(key, JSON.stringify(now)); }
  }, { flush: 'sync' });
  return value;
}
