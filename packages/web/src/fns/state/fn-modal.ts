/**
 * The one fn modal of the app (`FnModal`, drawn once by `App.vue`), bound to the URL as `?fn=<qualified name>` on
 * whatever page is open, so a fn looked into from anywhere is a shareable link and Back closes it. Anything that
 * shows a fn opens it through `useFnModal().open(name)` (a `FnPill` does). A page that knows more than the fn's name
 * (the chat's runs of it, where a run opens, a list that follows its on/off switch) says so with `within(scope)` for
 * as long as it is mounted; the newest scope wins, and a modal opened from a shared link gets the same scope.
 */
import { QualifiedName, type RunId } from '@harness/core';
import { computed, inject, onScopeDispose, provide, shallowRef, type ComputedRef, type InjectionKey } from 'vue';
import type { LocationQuery, RouteLocationRaw, Router } from 'vue-router';
import { links } from '../../app/routes.ts';
import type { RunView } from '../../chat/logic/runs.ts';

/** The query key the open fn is kept under, on every page. */
export const FN_KEY = 'fn';

/** The query key of the modal's tab (an agent's Injected tab), kept and dropped with the fn. */
export const FN_TAB_KEY = 'fnTab';

/** What the page under the modal adds to it. */
export interface FnModalScope {
  /** The runs it knows of, in call order; those of the fn shown list under its overview. */
  readonly runs?: () => readonly RunView[];
  /** Where a run opens (default: the runs browser); the modal closes as it goes there. */
  readonly run?: (id: RunId) => RouteLocationRaw;
  /** Told when the fn is turned on or off in the modal, so the page's own list follows. */
  readonly switched?: (fn: QualifiedName, on: boolean) => void;
}

/** The app's fn modal. */
export interface FnModal {
  /** The fn open, read from the URL; undefined when closed (or the URL's value isn't a qualified name). */
  readonly name: ComputedRef<QualifiedName | undefined>;
  /** What the page under it adds (the newest scope). */
  readonly scope: ComputedRef<FnModalScope>;
  /** Open a fn (a history entry, so Back closes it; opening another from inside it stacks too). */
  open(name: QualifiedName): void;
  /** Close it: back when the entry before is this page without it, else replace. */
  close(): void;
  /** Open a run where the page opens runs, closing the modal in the same move. */
  openRun(id: RunId): void;
  /** Add a scope for as long as the calling effect scope (a component's setup) lives. */
  within(scope: FnModalScope): void;
}

export const FN_MODAL: InjectionKey<FnModal> = Symbol('fn modal');

/** The first string of a query value. */
function one(value: LocationQuery[string] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/** A query without the fn key (and the modal's tab). */
export function withoutFn(query: LocationQuery): LocationQuery {
  return Object.fromEntries(Object.entries(query).filter(([key]) => key !== FN_KEY && key !== FN_TAB_KEY));
}

/** The app's fn modal over a router. */
export function createFnModal(router: Router): FnModal {
  const route = router.currentRoute;
  const scopes = shallowRef<readonly FnModalScope[]>([]);
  const name = computed(() => {
    const parsed = QualifiedName.safeParse(one(route.value.query[FN_KEY]));
    return parsed.success ? parsed.data : undefined;
  });

  function close(): void {
    if (name.value === undefined) { return; }
    const target = router.resolve({ query: withoutFn(route.value.query), hash: route.value.hash }).fullPath;
    const state: unknown = typeof window === 'undefined' ? null : window.history.state;
    const back: unknown = state !== null && typeof state === 'object' ? Reflect.get(state, 'back') : undefined;
    if (back === target) { router.back(); } else { void router.replace(target); }
  }

  return {
    name,
    scope: computed(() => scopes.value.at(-1) ?? {}),
    open(fn) {
      if (fn === name.value) { return; }
      void router.push({ query: { ...route.value.query, [FN_KEY]: fn }, hash: route.value.hash });
    },
    close,
    openRun(id) {
      const to = router.resolve(scopes.value.at(-1)?.run?.(id) ?? links.runs({ run: id }));
      void router.push({ path: to.path, query: withoutFn(to.query), hash: to.hash });
    },
    within(scope) {
      scopes.value = [...scopes.value, scope];
      onScopeDispose(() => { scopes.value = scopes.value.filter((other) => other !== scope); });
    },
  };
}

/** Make the app's fn modal and provide it to everything under the caller (`App.vue`). */
export function provideFnModal(router: Router): FnModal {
  const modal = createFnModal(router);
  provide(FN_MODAL, modal);
  return modal;
}

/** The app's fn modal; undefined outside the app (a component mounted alone), where fns show as plain labels. */
export function useFnModal(): FnModal | undefined {
  return inject(FN_MODAL, undefined);
}
