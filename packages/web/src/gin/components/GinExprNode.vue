<script setup lang="ts">
/**
 * One node of a gin expression, edited, with an editor for each of gin's twelve kinds: a value (its type and value,
 * with the gin editors), a read or write path (fields, calls with named arguments, indexes), a template, if and switch
 * branches, a define's variables, a block's steps, a loop, a function body, a flow action and a native id. Dense: the
 * kind, its small fields, what it evaluates to and its comment (behind an info icon) share one line, a value's type
 * editor stays folded until asked for, and each child sits on a row after its label. Editing swaps a node's kind, adds and removes branches, steps, cases and arguments,
 * and emits each changed definition upward. Reading an expression is `GinCode`'s job.
 */
import type { ExprDef, Type } from '@aeye/gin';
import type { GinTypeDef, Json } from '@harness/core';
import { computed, inject, ref } from 'vue';
import { UiBadge, UiButton, UiCodeBlock, UiIconButton, UiInput, UiMenu, UiSelect, UiTextarea, type MenuItem } from '../../ui/index.ts';
import GinTypeView from '../GinTypeView.vue';
import GinValueView from '../GinValueView.vue';
import {
  childrenOf, EXPR_KINDS, FLOW_ACTIONS, problemsAt, removalOf, viewOf, withChild, withList, withScalar,
  type ExprChild, type ExprKind, type ExprList, type ExprProblem, type ListEdit, type ScalarEdit, type StepView,
} from '../logic/expr.ts';
import { EXPR_TOOLS, sharedExprTools } from '../state.ts';
import GinNote from './GinNote.vue';

const props = withDefaults(defineProps<{
  def: ExprDef;
  /** Where this node is in the whole expression (`ifs.0.body`), for gin's problems. */
  path?: string;
  /** gin's problems with the whole expression. */
  problems?: readonly ExprProblem[];
  /** The variables in scope, typed. */
  scope?: ReadonlyMap<string, Type>;
  /** What holds the node, for labels. */
  label?: string;
  /** Offer to take this node out (an optional slot, or an item of a list). */
  removable?: boolean;
}>(), { path: '', problems: () => [], scope: () => new Map(), label: 'Expression', removable: false });

const emit = defineEmits<{ update: [def: ExprDef]; remove: [] }>();
const tools = inject(EXPR_TOOLS, sharedExprTools, true);

const parsed = computed(() => tools.parse(props.def));
const view = computed(() => (parsed.value.ok ? viewOf(parsed.value.value) : undefined));
const typeText = computed(() => (parsed.value.ok ? tools.typeText(parsed.value.value, props.scope) : ''));
const children = computed(() => (view.value === undefined ? [] : childrenOf(view.value)));
const own = computed(() => problemsAt(props.problems, props.path));
/** The node's errors, shown under its line. */
const errors = computed(() => own.value.filter((p) => p.severity === 'error'));
/** Its warnings and tips, behind the note icon on its line (their text is the icon's label too). */
const notes = computed(() => own.value.filter((p) => p.severity !== 'error'));
const warned = computed(() => notes.value.some((p) => p.severity === 'warning'));
const notesOpen = ref(false);
const notesLabel = computed(() => (notesOpen.value ? 'Hide notes' : notes.value.map((p) => p.message).join(' ')));
const firstVariable = computed(() => [...props.scope.keys()][0] ?? 'value');
const KIND_OPTIONS = EXPR_KINDS.map((k) => ({ value: k.kind, label: k.label }));
const ACTION_OPTIONS = FLOW_ACTIONS.map((action) => ({ value: action, label: action }));
const join = (sub: string): string => (props.path === '' ? sub : `${props.path}.${sub}`);

type StepAdd = 'prop' | 'call' | 'key';
const STEP_MENU: readonly MenuItem<StepAdd>[] = [
  { value: 'prop', label: 'Field', icon: 'arrow-right' }, { value: 'call', label: 'Call', icon: 'play' }, { value: 'key', label: 'Index', icon: 'tree' },
];

function swap(kind: ExprKind): void {
  if (view.value?.kind !== kind) { emit('update', tools.blank(kind, firstVariable.value)); }
}
function scalar(edit: ScalarEdit): void {
  if (view.value !== undefined) { emit('update', withScalar(view.value, edit)); }
}
function list(of: ExprList, edit: ListEdit): void {
  if (view.value !== undefined) { emit('update', withList(view.value, of, edit, () => tools.blank('new', firstVariable.value))); }
}
function setChild(child: ExprChild, def: ExprDef | undefined): void {
  if (view.value !== undefined) { emit('update', withChild(view.value, child.slot, def)); }
}
function removeChild(child: ExprChild): void {
  const removal = view.value === undefined ? undefined : removalOf(view.value, child);
  if (removal === undefined) { return; }
  if (removal.by === 'empty') { setChild(child, undefined); } else { list(removal.list, { op: 'remove', index: removal.index }); }
}
function fill(child: ExprChild): void {
  setChild(child, tools.blank('new', firstVariable.value));
}
const canRemove = (child: ExprChild): boolean => view.value !== undefined && removalOf(view.value, child) !== undefined;

const newType = computed<GinTypeDef | undefined>(() => (view.value?.kind === 'new' ? view.value.def.type : undefined));
const newValue = computed<Json | undefined>(() => (view.value?.kind === 'new' ? view.value.value : undefined));
const steps = computed<readonly StepView[]>(() => (view.value?.kind === 'get' || view.value?.kind === 'set' ? view.value.steps : []));
const lambdaType = computed(() => (view.value?.kind === 'lambda' ? view.value.type.toCode() : ''));
const comment = computed(() => (typeof props.def.comment === 'string' ? props.def.comment : ''));
/** A value's type editor, folded away until asked for: most values keep the type they have. */
const typeOpen = ref(false);
const grows = computed(() => view.value?.kind === 'block' || view.value?.kind === 'if' || view.value?.kind === 'switch');
</script>

<template>
  <div class="gin-expr-node" :class="`kind-${view?.kind ?? 'unreadable'}`" :data-path="path" :data-kind="view?.kind" data-testid="gin-expr-node">
    <div class="head">
      <UiSelect
        v-if="view && view.kind !== 'other'" class="kind" :model-value="view.kind" :options="KIND_OPTIONS" :label="`${label}: kind`" hide-label size="sm"
        @update:model-value="swap($event)"
      />
      <UiBadge v-else tone="accent">{{ view ? 'Code' : 'Unreadable' }}</UiBadge>

      <template v-if="view">
        <!-- a path on the line: fields, calls and indexes -->
        <span v-if="view.kind === 'get' || view.kind === 'set'" class="path" data-testid="gin-expr-path">
          <template v-for="(step, i) in steps" :key="i">
            <span v-if="step.kind === 'prop'" class="step">
              <span v-if="i > 0" class="punct" aria-hidden="true">.</span>
              <UiInput
                class="name-input" :model-value="step.name" :label="i === 0 ? 'Variable' : `Field ${i + 1}`" hide-label size="sm"
                @update:model-value="scalar({ field: 'prop', step: i, name: $event })"
              />
            </span>
            <span v-else-if="step.kind === 'call'" class="step">
              <code class="punct">(</code>
              <UiInput
                v-for="[name] in step.args" :key="name" class="name-input" :model-value="name" :label="`Argument ${name} name`" hide-label size="sm"
                @update:model-value="scalar({ field: 'arg', step: i, from: name, to: $event })"
              />
              <UiIconButton icon="plus" size="sm" label="Add argument" @click="list({ of: 'args', step: i }, { op: 'add' })" />
              <code class="punct">)</code>
            </span>
            <code v-else class="punct">[ ]</code>
            <UiIconButton v-if="steps.length > 1" icon="x" size="sm" :label="`Remove step ${i + 1}`" @click="list({ of: 'steps' }, { op: 'remove', index: i })" />
          </template>
          <UiMenu :items="STEP_MENU" label="Add a step" @select="list({ of: 'steps' }, { op: 'add', step: $event })">
            <template #trigger="{ toggle, attrs }"><UiIconButton icon="plus" size="sm" label="Add a step" v-bind="attrs" @click="toggle" /></template>
          </UiMenu>
        </span>

        <!-- the small fields of the other kinds, on the line too -->
        <template v-else-if="view.kind === 'define'">
          <UiInput
            v-for="(v, i) in view.def.vars" :key="i" class="name-input" :model-value="v.name" :label="`Variable ${i + 1}`" hide-label size="sm"
            @update:model-value="scalar({ field: 'var', index: i, name: $event })"
          />
          <UiIconButton icon="plus" size="sm" label="Add a variable" @click="list({ of: 'vars' }, { op: 'add' })" />
        </template>
        <template v-else-if="view.kind === 'loop'">
          <UiInput class="name-input" :model-value="view.def.key ?? ''" label="Key name" hide-label placeholder="key" size="sm" @update:model-value="scalar({ field: 'loop-key', name: $event })" />
          <UiInput class="name-input" :model-value="view.def.value ?? ''" label="Value name" hide-label placeholder="value" size="sm" @update:model-value="scalar({ field: 'loop-value', name: $event })" />
        </template>
        <UiSelect
          v-else-if="view.kind === 'flow'" class="kind" :model-value="view.def.action" :options="ACTION_OPTIONS" label="Action" hide-label size="sm"
          @update:model-value="scalar({ field: 'action', action: $event })"
        />
        <UiInput v-else-if="view.kind === 'native'" :model-value="view.def.id" label="Native id" hide-label placeholder="num.add" size="sm" @update:model-value="scalar({ field: 'native', id: $event })" />
        <code v-else-if="view.kind === 'lambda'" class="type-code">{{ lambdaType }}</code>
      </template>

      <!-- a literal's value on the line, as code reads it -->
      <GinValueView
        v-if="view?.kind === 'new'" class="literal" :type="newType" :model-value="newValue" :label="`${label} value`" inline
        @update:model-value="scalar({ field: 'new-value', value: $event })"
      />
      <span class="ends">
        <code v-if="typeText !== '' && typeText !== 'any'" class="type" title="What it evaluates to">→ {{ typeText }}</code>
        <UiIconButton
          v-if="notes.length > 0" :icon="warned ? 'warning' : 'info'" size="sm" class="notes-toggle" :class="{ warn: warned }" :label="notesLabel" :pressed="notesOpen"
          data-testid="gin-expr-notes" @click="notesOpen = !notesOpen"
        />
        <UiIconButton
          v-if="view?.kind === 'new'" icon="braces" size="sm" :label="typeOpen ? 'Hide its type' : 'Change its type'" :pressed="typeOpen" data-testid="gin-expr-type-toggle"
          @click="typeOpen = !typeOpen"
        />
        <GinNote v-if="view" :model-value="comment" :label="`Comment on ${label}`" editable @update:model-value="scalar({ field: 'comment', text: $event })" />
        <UiIconButton v-if="removable" icon="x" size="sm" :label="`Remove ${label}`" @click="emit('remove')" />
      </span>
    </div>
    <p v-if="!parsed.ok" class="problem" role="alert">{{ parsed.problem }}</p>
    <!-- errors show at once; warnings and tips wait behind the note icon on the line -->
    <p v-for="(problem, i) in errors" :key="i" class="problem" role="alert">{{ problem.message }}</p>
    <template v-if="notesOpen"><p v-for="(problem, i) in notes" :key="`note-${i}`" class="problem" :class="problem.severity">{{ problem.message }}</p></template>

    <template v-if="view">
      <div v-if="view.kind === 'new' && typeOpen" class="value">
        <GinTypeView :model-value="newType" :label="`${label} type`" @update:model-value="scalar({ field: 'new-type', type: $event })" />
      </div>
      <UiTextarea
        v-else-if="view.kind === 'template'" :model-value="view.text" label="Template" hide-label placeholder="Hello {name}" :rows="1"
        @update:model-value="scalar({ field: 'template', text: $event })"
      />
      <UiCodeBlock v-else-if="view.kind === 'other'" :code="parsed.ok ? tools.code(parsed.value) : ''" language="ts" :max-height="240" />

      <!-- children, each on a row after its label -->
      <div v-if="children.length > 0" class="children">
        <div v-for="child in children" :key="child.path" class="slot">
          <span class="slot-label">{{ child.label }}</span>
          <GinExprNode
            v-if="child.def" :def="child.def" :path="join(child.path)" :problems="problems" :scope="scope" :label="child.label"
            :removable="canRemove(child)" @update="setChild(child, $event)" @remove="removeChild(child)"
          />
          <UiButton v-else class="fill" size="sm" variant="ghost" icon="plus" @click="fill(child)">Add</UiButton>
        </div>
      </div>

      <!-- growing a node's lists -->
      <div v-if="grows" class="grow">
        <UiButton v-if="view.kind === 'block'" size="sm" variant="ghost" icon="plus" @click="list({ of: 'lines' }, { op: 'add' })">Step</UiButton>
        <UiButton v-if="view.kind === 'if'" size="sm" variant="ghost" icon="plus" @click="list({ of: 'branches' }, { op: 'add' })">Else if</UiButton>
        <template v-if="view.kind === 'switch'">
          <UiButton size="sm" variant="ghost" icon="plus" @click="list({ of: 'cases' }, { op: 'add' })">Case</UiButton>
          <UiButton v-for="n in view.def.cases.length" :key="n" size="sm" variant="ghost" icon="plus" @click="list({ of: 'equals', index: n - 1 }, { op: 'add' })">
            Or for case {{ n }}
          </UiButton>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gin-expr-node { display: grid; gap: var(--space-1); min-width: 0; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-2); min-width: 0; }
.kind { width: auto; min-width: 7rem; max-width: 100%; }
.type { color: var(--text-faint); font: var(--text-xs) var(--mono); overflow-wrap: anywhere; }
.ends { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; white-space: nowrap; }
.literal { flex: 1 1 8rem; min-width: 0; }
.notes-toggle { color: var(--text-dim); }
.notes-toggle.warn { color: var(--warn); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-xs); }
.problem.warning { color: var(--warn); }
.problem.info { color: var(--text-dim); }
.value { display: flex; flex-wrap: wrap; align-items: start; gap: var(--space-2); min-width: 0; }
.value > * { flex: 1 1 14rem; min-width: 0; }
.path, .step { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 2px; min-width: 0; }
.punct { color: var(--text-faint); font-family: var(--mono); }
.name-input { width: 8rem; max-width: 100%; }
.type-code { font: var(--text-xs) var(--mono); color: var(--text-dim); overflow-wrap: anywhere; }
.children { display: grid; gap: var(--space-1); padding-left: var(--space-2); border-left: 2px solid var(--border); min-width: 0; }
.slot { display: grid; grid-template-columns: minmax(3rem, max-content) minmax(0, 1fr); align-items: start; gap: var(--space-2); min-width: 0; }
.slot-label { padding-top: 5px; color: var(--text-dim); font: var(--weight-medium) var(--text-xs) var(--mono); white-space: nowrap; }
.fill { justify-self: start; }
.grow { display: flex; flex-wrap: wrap; gap: var(--space-1); }
@media (max-width: 480px) {
  .slot { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .slot-label { padding-top: 0; }
}
</style>
