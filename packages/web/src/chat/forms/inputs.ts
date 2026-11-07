/**
 * Custom inputs for named types. A system registers inputs for its own types (`inputs: { Entry: EntryInput }`); the
 * chat provides a lookup under `FORM_INPUTS`, and a form asks it for every ref node. Without one, the ref's value is
 * entered as JSON.
 */
import type { Component, InjectionKey } from 'vue';

/** A custom input and the extra props it gets (its system's client). */
export interface CustomInput {
  readonly component: Component;
  readonly props: Readonly<Record<string, unknown>>;
}

/** Find the custom input for a named type (`fs/Entry`). */
export type InputLookup = (type: string) => CustomInput | undefined;

export const FORM_INPUTS: InjectionKey<InputLookup> = Symbol('harness.formInputs');
