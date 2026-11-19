/**
 * The widgets client's words and args, apart from any component: what Save keeps (`save_widget`'s args) and the name
 * it keeps it under, the request that changes a proposal (put in the composer to finish), the `make_widget` args that
 * keep a look picked in a saved widget's Settings, the saved widgets' search (one page of the hub's fn search), and the
 * link to the saved widgets' page.
 */
import { QualifiedName, systemPagePath, WIDGET_KIND, WIDGETS_SYSTEM, type FnSearchQuery, type MakeWidgetArgs, type SaveWidgetArgs, type WidgetProposal, type WidgetResult } from '@harness/core';
import type { ResultLook } from '@harness/sdk';
import { WIDGETS_PAGE } from '../shared/index.ts';

/** A proposal as `widgets/save_widget` takes it: saved over the widget it changes, when it changes one. */
export function saveArgs(proposal: Pick<WidgetProposal, 'name' | 'description' | 'spec' | 'replaces'>): SaveWidgetArgs {
  return { name: proposal.name, description: proposal.description, spec: proposal.spec, ...(proposal.replaces === undefined ? {} : { replace: proposal.replaces }) };
}

/** The widget fn a proposal is kept as: the one it changes, else `widgets/<name>`. */
export function savedName(proposal: Pick<WidgetProposal, 'name' | 'replaces'>): QualifiedName {
  return proposal.replaces ?? QualifiedName.parse(`${WIDGETS_SYSTEM}/${proposal.name}`);
}

/** The request that asks the agent to change a proposal before it is saved; the person finishes it in the composer. */
export function changeRequest(proposal: Pick<WidgetProposal, 'spec'>): string {
  return `Change the proposed widget “${proposal.spec.title}” (from ${proposal.spec.source}): `;
}

/**
 * The `make_widget` args that keep the look picked in a saved widget's Settings as its own: the same source, the
 * widget it changes, and the look first. It proposes; the person saves the proposal.
 */
export function lookArgs(widget: QualifiedName, result: Pick<WidgetResult, 'source'>, look: ResultLook): MakeWidgetArgs {
  return {
    source: result.source.fn,
    request: `Open it as ${look.visual} (${look.style}) first, keeping its other visuals and everything else.`,
    widget,
    show: true,
  };
}

/** How many saved widgets a page of the list holds. */
export const WIDGETS_PAGE_SIZE = 50;

/** One page of the saved widgets: the hub's fn search over the widget kind, by words, from `offset`. */
export function widgetSearch(text: string, offset: number): FnSearchQuery {
  const words = text.trim();
  return { kinds: [WIDGET_KIND], items: ['fn'], limit: WIDGETS_PAGE_SIZE, offset, ...(words === '' ? {} : { text: words }) };
}

/** The saved widgets' page, searched for one widget's name when given. */
export function widgetsPageHref(name?: QualifiedName): string {
  const path = systemPagePath(WIDGETS_SYSTEM, WIDGETS_PAGE);
  return name === undefined ? path : `${path}?q=${encodeURIComponent(name)}`;
}
