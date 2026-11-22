/**
 * Injected context as an admin reads it (plan `injected-context-2026-11-22`, slice F): an agent's Injected tab lists,
 * in order, each item that reaches it (`InjectionView`), with its state in words, why it is left out, the target that
 * took it in and the section's total; an item's own page lists, per agent it reaches, the same views. Pure, so the
 * tab, the context page and their tests share it.
 */
import type { InjectionLeftOut, InjectionView, QualifiedName } from '@harness/core';
import type { TabItem, Tone } from '../../ui/index.ts';

import { FnTab } from '../sections.ts';

export { FnTab };

/** The kind whose fns are agents. */
export const AGENT_KIND = 'hub/llm';

/** The tabs a fn shows: an agent also has its Injected tab, with how many items reach it when known. */
export function fnTabs(isAgent: boolean, injected?: number): Array<TabItem<FnTab>> {
  return isAgent
    ? [{ value: 'about', label: 'About', icon: 'info' }, { value: 'injected', label: 'Injected', icon: 'layers', ...(injected === undefined ? {} : { count: injected }) }]
    : [{ value: 'about', label: 'About', icon: 'info' }];
}

/** Why an item is left out, in a few words. */
export const LEFT_OUT_WORDS: Readonly<Record<InjectionLeftOut, string>> = {
  off: 'Switched off',
  pending: 'Waiting for review',
  declined: 'Declined',
  'system-off': 'System off',
  'fns-unusable': 'Its fns can\'t be used',
  mode: 'Other chat mode',
  'no-fit': 'Didn\'t fit',
};

/** An item's state as a badge: in the prompt, or why not. */
export interface InjectionState {
  readonly label: string;
  readonly tone: Tone;
  /** Whether it is in the agent's prompt now. */
  readonly in: boolean;
}

/** The state of one item in one agent. */
export function injectionState(view: Pick<InjectionView, 'leftOut' | 'detail'>): InjectionState {
  const why = view.leftOut?.why;
  if (why === undefined) { return { label: view.detail === 'summary' ? 'In, as its summary' : 'In', tone: 'ok', in: true }; }
  const tone: Tone = why === 'off' ? 'neutral' : why === 'declined' ? 'danger' : 'warn';
  return { label: LEFT_OUT_WORDS[why], tone, in: false };
}

/** What the agent's section adds up to: how many items are in it, out of how many reach it, and their tokens. */
export interface InjectedTotal {
  readonly in: number;
  readonly of: number;
  readonly tokens: number;
}

/** The total of an agent's section from its views. */
export function injectedTotal(views: readonly Pick<InjectionView, 'leftOut' | 'tokens'>[]): InjectedTotal {
  const shown = views.filter((view) => view.leftOut === undefined);
  return { in: shown.length, of: views.length, tokens: shown.reduce((sum, view) => sum + view.tokens, 0) };
}

/** The total line: "3 of 5 items in · about 1,240 tokens". */
export function totalLine(total: InjectedTotal): string {
  if (total.of === 0) { return 'Nothing is injected into this agent.'; }
  const items = total.of === 1 ? 'item' : 'items';
  return `${total.in.toLocaleString('en-US')} of ${total.of.toLocaleString('en-US')} ${items} in · about ${total.tokens.toLocaleString('en-US')} tokens`;
}

/** Where an item came from: a context item, or what a hook's block means. */
export function sourceWords(view: Pick<InjectionView, 'source'>): string {
  return view.source.type === 'hook' ? 'What a hook\'s block means' : 'Context';
}

/** Which target took it in, in words: the agent by name, or a pattern that hit it. */
export function viaWords(view: Pick<InjectionView, 'via' | 'agent'>): string {
  return view.via === view.agent ? 'Named directly' : `Matched by ${view.via}`;
}

/** The lowest and highest order an admin may give. */
export const ORDER_RANGE = { min: 0, max: 1000 } as const;

/** An order typed by an admin, if it is a whole number in range. */
export function parseOrder(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) { return undefined; }
  const value = Number(trimmed);
  return value >= ORDER_RANGE.min && value <= ORDER_RANGE.max ? value : undefined;
}

/**
 * The order that moves item `index` one place earlier (`-1`) or later (`1`) in the list: one before or after its
 * neighbour's, kept in range; undefined at either end, or when the neighbour is already at the range's edge.
 */
export function movedOrder(views: readonly Pick<InjectionView, 'order'>[], index: number, step: -1 | 1): number | undefined {
  const neighbour = views[index + step];
  if (views[index] === undefined || neighbour === undefined) { return undefined; }
  const next = neighbour.order + step;
  return next < ORDER_RANGE.min || next > ORDER_RANGE.max ? undefined : next;
}

/** One item's views in every agent it reaches, by agent, in name order (the context page's list). */
export function byAgent(views: readonly InjectionView[]): Array<{ agent: QualifiedName; view: InjectionView }> {
  return [...views].sort((a, b) => a.agent.localeCompare(b.agent)).map((view) => ({ agent: view.agent, view }));
}
