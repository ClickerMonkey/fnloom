/**
 * The gin editors' state, so their components only draw:
 * - `FormState`: a value being typed for a gin type. The draft is read into a value (`encode`), and gin's value
 *   schema for the type, with its named types bound from the browser's type library, says whether it fits and which
 *   field is wrong; problems show once the person has started.
 * - `ValueEditor`: a `FormState` behind a `v-model`: it says the value to emit after each edit and starts again when
 *   the value is changed from outside.
 * - `TypeEditor`: a gin type definition being edited as a `TypeShape`, checked live by gin.
 * - `ExprEditor`: a gin expression parsed by gin, with its result type, problems and code, for the variables in scope.
 */
import type { Expr, ExprDef, Registry, Type, TypeDef } from '@aeye/gin';
import type { GinExprDef, GinTypeDef, Json } from '@harness/core';
import { g } from '@harness/sdk';
import { computed, ref, shallowRef, type ComputedRef, type InjectionKey, type ShallowRef } from 'vue';
import { ExprTools, viewOf, type ExprProblem, type ExprView } from './logic/expr.ts';
import { draftOf, encode, formOf, issueProblems, type Draft, type Encoded, type FormNode, type FormProblem } from './logic/form.ts';
import { checkShape, shapeOf, type CheckedShape, type TypeShape } from './logic/typedef.ts';
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
  /** The draft read into a value and checked by gin, whether or not problems show yet. */
  readonly checked = computed<Encoded>(() => {
    const encoded = encode(this.node, this.draft.value);
    if (!encoded.ok || this.#gin === undefined) { return encoded; }
    const problems = issueProblems(this.#gin(encoded.value));
    return problems.length === 0 ? encoded : { ok: false, problems };
  });
  /** Problems with the draft now (shown once the person has started). */
  readonly problems = computed<readonly FormProblem[]>(() => (this.tried.value && !this.checked.value.ok ? this.checked.value.problems : []));
  /** Whether the draft would submit. */
  readonly valid = computed(() => this.checked.value.ok);

  /** `types` finds the named types the definition refers to; load them first (`TypeSource.need`). */
  constructor(def: unknown, initial?: Json, types: TypeSource = LOCAL_TYPES) {
    this.def = def;
    this.node = formOf(def, '', types);
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
    return this.checked.value;
  }

  reset(initial?: Json): void {
    this.tried.value = false;
    this.draft.value = draftOf(this.node, initial);
  }
}

/** The same JSON, by value. */
function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A value of a gin type edited through `v-model`. Each edit that fits the type is the value to emit; one that
 * doesn't keeps the last good value and shows its problems. A value set from outside that differs from the last one
 * emitted starts the draft again from it, so the editor and its owner never fight.
 */
export class ValueEditor {
  readonly #types: TypeSource;
  readonly form: ShallowRef<FormState>;
  #emitted: Json | undefined;

  constructor(def: unknown, initial: Json | undefined, types: TypeSource = LOCAL_TYPES) {
    this.#types = types;
    this.#emitted = initial;
    this.form = shallowRef(new FormState(def, initial, types));
  }

  /** The node drawn. */
  get node(): FormNode {
    return this.form.value.node;
  }

  /** The person changed the draft: the value to emit when it fits (and differs from the last one), else undefined. */
  update(draft: Draft): { readonly value: Json } | undefined {
    const form = this.form.value;
    form.update(draft);
    const checked = form.checked.value;
    if (!checked.ok || sameJson(checked.value, this.#emitted)) { return undefined; }
    this.#emitted = checked.value;
    return { value: checked.value };
  }

  /** The owner set the value: start again from it unless it is the one just emitted. */
  accept(value: Json | undefined): void {
    if (sameJson(value, this.#emitted)) { return; }
    this.#emitted = value;
    this.form.value.reset(value);
  }

  /** The type changed (or its named types arrived): read it again, keeping the current value. */
  retype(def: unknown): void {
    this.form.value = new FormState(def, this.#emitted, this.#types);
  }
}

/** A type definition being edited: its shape, gin's check of it, and the definition to emit when it checks out. */
export class TypeEditor {
  readonly #registry: Registry;
  readonly #types: TypeSource;
  /** The shape being edited; undefined when the definition isn't one gin can read. */
  readonly shape = shallowRef<TypeShape | undefined>(undefined);
  /** gin's check of the shape. */
  readonly checked: ComputedRef<CheckedShape | undefined>;
  /** Why the definition given couldn't be read, if it couldn't. */
  readonly unreadable = ref('');
  #emitted: string | undefined;

  constructor(def: GinTypeDef | undefined, registry: Registry, types: TypeSource = LOCAL_TYPES) {
    this.#registry = registry;
    this.#types = types;
    this.checked = computed(() => {
      const shape = this.shape.value;
      return shape === undefined ? undefined : checkShape(shape, this.#registry, (d) => this.#types.type(d));
    });
    this.accept(def);
  }

  /** The owner set the definition: read it into a shape unless it is the one just emitted. */
  accept(def: GinTypeDef | undefined): void {
    const text = def === undefined ? undefined : JSON.stringify(def);
    if (text !== undefined && text === this.#emitted) { return; }
    this.read(def);
  }

  /** Read a definition into a shape again (its named types have arrived), whatever was emitted. */
  read(def: GinTypeDef | undefined): void {
    this.#emitted = def === undefined ? undefined : JSON.stringify(def);
    if (def === undefined) { this.shape.value = undefined; this.unreadable.value = ''; return; }
    const type = this.#types.type(def);
    this.unreadable.value = type === undefined ? "This type can't be read." : '';
    this.shape.value = type === undefined ? undefined : shapeOf(type);
  }

  /** The person changed the shape: the definition to emit when gin accepts it, else undefined. */
  update(shape: TypeShape): { readonly def: TypeDef } | undefined {
    this.shape.value = shape;
    const checked = this.checked.value;
    if (checked === undefined || !checked.ok) { return undefined; }
    this.#emitted = JSON.stringify(checked.def);
    return { def: checked.def };
  }
}

/** An expression being looked at or edited: gin's parse of it, its view, result type, problems and code. */
export class ExprEditor {
  readonly tools: ExprTools;
  readonly #types: TypeSource;
  readonly def = shallowRef<ExprDef | undefined>(undefined);
  /** The variables in scope and their types (definitions). */
  readonly scopeDefs = shallowRef<Readonly<Record<string, GinTypeDef>>>({});

  /** The variables in scope as live types; one whose type can't be read is left out. */
  readonly scope = computed<ReadonlyMap<string, Type>>(() => new Map(Object.entries(this.scopeDefs.value).flatMap(([name, def]) => {
    const type = this.#types.type(def);
    return type === undefined ? [] : [[name, type] as const];
  })));
  readonly parsed = computed(() => (this.def.value === undefined ? undefined : this.tools.parse(this.def.value)));
  readonly expr = computed<Expr | undefined>(() => (this.parsed.value?.ok === true ? this.parsed.value.value : undefined));
  readonly view = computed<ExprView | undefined>(() => (this.expr.value === undefined ? undefined : viewOf(this.expr.value)));
  readonly typeText = computed(() => (this.expr.value === undefined ? '' : this.tools.typeText(this.expr.value, this.scope.value)));
  readonly problems = computed<readonly ExprProblem[]>(() => (this.expr.value === undefined ? [] : this.tools.problems(this.expr.value, this.scope.value)));
  readonly code = computed(() => (this.expr.value === undefined ? '' : this.tools.code(this.expr.value)));
  /** Why gin couldn't read the definition, if it couldn't. */
  readonly unreadable = computed(() => (this.parsed.value?.ok === false ? this.parsed.value.problem : ''));

  constructor(tools: ExprTools, types: TypeSource = LOCAL_TYPES) {
    this.tools = tools;
    this.#types = types;
  }

  /** Look at (or start editing) a definition, with these variables in scope. */
  show(def: GinExprDef | undefined, scope: Readonly<Record<string, GinTypeDef>>): void {
    this.def.value = def;
    this.scopeDefs.value = scope;
  }
}

/** Where expression components find gin's tools (the expression view provides its own). */
export const EXPR_TOOLS: InjectionKey<ExprTools> = Symbol('harness.exprTools');

let shared: ExprTools | undefined;
/** The tools over the browser's registry (`g`), made once on first use. */
export function sharedExprTools(): ExprTools {
  shared ??= new ExprTools(g);
  return shared;
}
