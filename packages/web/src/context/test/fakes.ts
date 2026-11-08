/**
 * Test doubles for the context pages: callers answering from the in-memory graph (`ContextGraphDouble`, which the
 * mock hub answers from too), a context-event channel a test pushes into, and the store built on them.
 */
import { IDS, type QualifiedName } from '@harness/core';
import { fakeCaller } from '../../test/fakes.ts';
import type { ContextEvents } from '../api/context.ts';
import { ContextStore } from '../state/context.ts';
import { ContextGraphDouble, fixtureGraph } from './graph.ts';

export { contextLink, contextRecord, fixtureGraph, T_CONTEXT } from './graph.ts';

/** A context-event channel a test pushes into. */
export function fakeContextEvents(): { readonly events: ContextEvents; push(name: QualifiedName): void; readonly listeners: number } {
  const listeners = new Set<(name: QualifiedName) => void>();
  return {
    events: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (changed) => { for (const listener of listeners) { listener(changed); } },
    get listeners() { return listeners.size; },
  };
}

/** Run `work` as a call would: its answer resolved, its refusal rejected. */
const answer = <R>(work: () => R): Promise<R> => Promise.resolve().then(work);

/** Callers answering from an in-memory graph the way the hub does. */
export function fakeContextApi(graph = fixtureGraph()) {
  const state = new ContextGraphDouble(IDS.actor.parse('act_ada'), undefined, graph);
  return {
    state,
    api: {
      list: fakeCaller<'contexts'>((query) => answer(() => state.list(query ?? {}))),
      item: fakeCaller<'contextItem'>((body) => answer(() => state.item(body.name))),
      remember: fakeCaller<'remember'>((args) => answer(() => state.remember(args))),
      updateMemory: fakeCaller<'updateMemory'>((args) => answer(() => state.update(args))),
      forget: fakeCaller<'forget'>((body) => answer(() => state.forget(body.name))),
      link: fakeCaller<'linkContext'>((body) => answer(() => state.link(body))),
      unlink: fakeCaller<'unlinkContext'>((body) => answer(() => state.unlink(body))),
      fromResource: fakeCaller<'contextFromResource'>((args) => answer(() => state.fromResource(args))),
    },
  };
}

/** The context store on fakes. */
export function fakeContext(graph = fixtureGraph()) {
  const { api, state } = fakeContextApi(graph);
  const events = fakeContextEvents();
  const context = new ContextStore({ api, events: events.events });
  return { context, api, state, events };
}
