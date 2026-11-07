/**
 * URL state: a query value or route param read through a zod enum (the one list of values it may take) and written
 * back to the URL, so the view and the address bar are the same state and a refresh restores it. Unknown values read
 * as the fallback.
 */
import { computed, onScopeDispose, ref, watch, type Ref, type WritableComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { z } from 'zod';

type Choices = z.ZodEnum;

/**
 * A query value as one of `schema`'s options. Writing it replaces the history entry (filters aren't places to go
 * back to); the fallback is left out of the URL.
 */
export function useQueryChoice<S extends Choices>(name: string, schema: S, fallback: z.output<S>): WritableComputedRef<z.output<S>> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => {
      const parsed = schema.safeParse(route.query[name]);
      return parsed.success ? parsed.data : fallback;
    },
    set: (value) => {
      const query = { ...route.query };
      if (value === fallback) { Reflect.deleteProperty(query, name); } else { query[name] = String(value); }
      void router.replace({ query, hash: route.hash });
    },
  });
}

/**
 * A free-text query value ('' when absent). Writing it replaces the history entry and leaves '' out of the URL, so
 * a browser's filters and the item it has open survive a refresh. `push` makes a history entry instead (opening a
 * panel, so Back closes it).
 */
export function useQueryText(name: string, options: { readonly push?: boolean } = {}): WritableComputedRef<string> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => {
      const value = route.query[name];
      return typeof value === 'string' ? value : '';
    },
    set: (value) => {
      const query = { ...route.query };
      if (value === '') { Reflect.deleteProperty(query, name); } else { query[name] = value; }
      const to = { query, hash: route.hash };
      void (options.push === true ? router.push(to) : router.replace(to));
    },
  });
}

/** A route param as one of `schema`'s options. Writing it pushes a history entry, so Back returns to the last one. */
export function useParamChoice<S extends Choices>(name: string, schema: S, fallback: z.output<S>): WritableComputedRef<z.output<S>> {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => {
      const parsed = schema.safeParse(route.params[name]);
      return parsed.success ? parsed.data : fallback;
    },
    set: (value) => {
      void router.push({ params: { ...route.params, [name]: String(value) }, query: route.query });
    },
  });
}

/**
 * A free-text query value being typed: `draft` follows the input at once, and the URL (and whatever watches it)
 * follows the draft once typing pauses for `delay` ms. A change in the URL (Back, a link) updates the draft.
 */
export function useQueryDraft(name: string, delay = 300): { readonly draft: Ref<string>; readonly value: Readonly<Ref<string>> } {
  const value = useQueryText(name);
  const draft = ref(value.value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(value, (now) => { if (now !== draft.value.trim()) { draft.value = now; } });
  watch(draft, (now) => {
    clearTimeout(timer);
    timer = setTimeout(() => { value.value = now.trim(); }, delay);
  });
  onScopeDispose(() => { clearTimeout(timer); });
  return { draft, value };
}
