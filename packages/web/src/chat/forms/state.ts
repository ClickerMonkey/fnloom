/**
 * A form's state: the node read from its gin type, the draft typed so far, and the problems once the person has
 * started on it (shown live from then on). `check` encodes the draft and asks gin to confirm the value fits.
 */
import type { Json } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { draftOf, encode, formOf, ginCheck, type Draft, type FormNode, type FormProblem } from './model.ts';

/** One form. */
export class FormState {
  readonly def: unknown;
  readonly node: FormNode;
  readonly draft = shallowRef<Draft>({ kind: 'value', value: undefined });
  /** Whether the person has changed something or tried to submit, so problems show. */
  readonly tried = ref(false);
  readonly #encoded = computed(() => encode(this.node, this.draft.value));
  /** Problems with the draft now (shown once the person has started). */
  readonly problems = computed<readonly FormProblem[]>(() => (this.tried.value && !this.#encoded.value.ok ? this.#encoded.value.problems : []));
  /** Whether the draft would submit. */
  readonly valid = computed(() => this.#encoded.value.ok);

  constructor(def: unknown, initial?: Json) {
    this.def = def;
    this.node = formOf(def);
    this.draft.value = draftOf(this.node, initial);
  }

  /** The person changed a value; problems show from now on. */
  update(draft: Draft): void {
    this.draft.value = draft;
    this.tried.value = true;
  }

  /** The value to submit, or the problems (now shown). gin's own check has the last word. */
  check(): { ok: true; value: Json } | { ok: false; problems: readonly FormProblem[] } {
    this.tried.value = true;
    const encoded = this.#encoded.value;
    if (!encoded.ok) { return encoded; }
    const gin = ginCheck(this.def, encoded.value);
    return gin === undefined || gin === '' ? encoded : { ok: false, problems: [{ path: '', message: gin }] };
  }

  reset(initial?: Json): void {
    this.tried.value = false;
    this.draft.value = draftOf(this.node, initial);
  }
}
