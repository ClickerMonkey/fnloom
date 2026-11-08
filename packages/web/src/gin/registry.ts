/**
 * Which component draws a value of a gin type. One rule, used everywhere a value is drawn (forms, run cards' args and
 * results, mention cards, the pairing config form, the MCP rules editor): a system's own component for its named
 * type (`client({ inputs: { Entry } })`) first, then the built-in input or viewer for the type's shape, and JSON when
 * the browser knows nothing about the type. The same system component edits and, with `readonly`, views.
 *
 * The chat provides the lookup under `GIN_INPUTS` (from the system client builds it has loaded); without one, named
 * types draw with their definition's shape or as JSON.
 */
import type { InputMount } from '@harness/sdk';
import type { InjectionKey } from 'vue';
import type { FormNode } from './logic/form.ts';

/** A system's component for a named type, the extra props it gets (its system's client), and its value codec. */
export type CustomInput = InputMount;

/** Find the system component for a named type (`fs/Entry`). */
export type InputLookup = (type: string) => CustomInput | undefined;

/** Where components find the system components for named types. */
export const GIN_INPUTS: InjectionKey<InputLookup> = Symbol('harness.ginInputs');

/** The lookup used when none is provided: no system components. */
export const NO_INPUTS: InputLookup = () => undefined;

/** How one value is drawn: by its system's component, by the built-in drawer for its shape, or as JSON. */
export type ValueDrawer =
  | { readonly kind: 'system'; readonly name: string; readonly input: CustomInput }
  | { readonly kind: 'builtin'; readonly node: FormNode }
  | { readonly kind: 'json'; readonly name: string };

/**
 * The drawer for a node. A named type (`ref`) uses its system's component when one is registered, else the built-in
 * drawer for its definition when the browser holds it, else JSON; a node read as untyped JSON is JSON; every other
 * node is drawn by the built-in drawer for its kind.
 */
export function drawerFor(node: FormNode, lookup: InputLookup): ValueDrawer {
  if (node.kind === 'ref') {
    const input = lookup(node.name);
    if (input !== undefined) { return { kind: 'system', name: node.name, input }; }
    return node.inner === undefined ? { kind: 'json', name: node.name } : drawerFor(node.inner, lookup);
  }
  return node.kind === 'json' ? { kind: 'json', name: '' } : { kind: 'builtin', node };
}
