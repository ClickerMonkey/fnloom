/**
 * A form's state: the node read from its gin type, the draft typed so far, and the problems once the person has
 * started on it (shown live from then on). The draft is read into a value (`encode`), and gin's value schema for the
 * type, with its named types bound from the browser's type library, says whether it fits and which field is wrong.
 */
import type { Json } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { draftOf, encode, formOf, issueProblems, type Draft, type Encoded, type FormNode, type FormProblem } from './model.ts';
import { LOCAL_TYPES, type TypeSource, type ValueCheck } from './types.ts';

/** One form. */
export class FormState {
  readonly def: unknown;
  readonly node: FormNode;
  readonly draft = shallowRef<Draft>({ kind: 'value', value: undefined });
  /** Whether the person has changed something or tried to submit, so problems show. */
  readonly tried = ref(false);
  /** gin's check of the type, made once; undefined when a named type it needs isn't known here. */
  readonly #gin: ValueCheck | undefined;
  readonly #checked = computed<Encoded>(() => {
    const encoded = encode(this.node, this.draft.value);
    if (!encoded.ok || this.#gin === undefined) { return encoded; }
    const problems = issueProblems(this.#gin(encoded.value));
    return problems.length === 0 ? encoded : { ok: false, problems };
  });
  /** Problems with the draft now (shown once the person has started). */
  readonly problems = computed<readonly FormProblem[]>(() => (this.tried.value && !this.#checked.value.ok ? this.#checked.value.problems : []));
  /** Whether the draft would submit. */
  readonly valid = computed(() => this.#checked.value.ok);

  /** `types` finds the named types the definition refers to; load them first (`TypeSource.need`). */
  constructor(def: unknown, initial?: Json, types: TypeSource = LOCAL_TYPES) {
    this.def = def;
    this.node = formOf(def, '', (name) => types.definition(name));
    this.#gin = types.checker(def);
    this.draft.value = draftOf(this.node, initial);
  }

  /** The person changed a value; problems show from now on. */
  update(draft: Draft): void {
    this.draft.value = draft;
    this.tried.value = true;
  }

  /** The value to submit, or the problems (now shown). */
  check(): Encoded {
    this.tried.value = true;
    return this.#checked.value;
  }

  reset(initial?: Json): void {
    this.tried.value = false;
    this.draft.value = draftOf(this.node, initial);
  }
}
