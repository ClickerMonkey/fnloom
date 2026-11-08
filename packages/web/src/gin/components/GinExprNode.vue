<script setup lang="ts">
/**
 * One node of a gin expression, viewed or edited, with an editor for each of gin's twelve kinds: a value (its type
 * and value, with the gin editors), a read or write path (fields, calls with named arguments, indexes), a template,
 * if and switch branches, a define's variables, a block's steps, a loop, a function body, a flow action and a native
 * id. Each node shows what it evaluates to (gin's `typeOf`) and the problems gin found at it. Editing swaps a node's
 * kind, adds and removes branches, steps, cases and arguments, and emits each changed definition upward.
 */
import type { ExprDef, Type } from '@aeye/gin';
import type { GinTypeDef, Json } from '@harness/core';
import { computed, inject } from 'vue';
import { UiBadge, UiButton, UiCodeBlock, UiIconButton, UiInput, UiMenu, UiSelect, UiTextarea, type MenuItem } from '../../ui/index.ts';
import GinTypeView from '../GinTypeView.vue';
import GinValueView from '../GinValueView.vue';
import {
  childrenOf, EXPR_KINDS, exprLabel, FLOW_ACTIONS, problemsAt, removalOf, viewOf, withChild, withList, withScalar,
  type ExprChild, type ExprKind, type ExprList, type ExprProblem, type ListEdit, type ScalarEdit, type StepView,
} from '../logic/expr.ts';
import { EXPR_TOOLS, sharedExprTools } from '../state.ts';

const props = withDefaults(defineProps<{
  def: ExprDef;
  readonly?: boolean;
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
}>(), { readonly: false, path: '', problems: () => [], scope: () => new Map(), label: 'Expression', removable: false });

const emit = defineEmits<{ update: [def: ExprDef]; remove: [] }>();
const tools = inject(EXPR_TOOLS, sharedExprTools, true);

const parsed = computed(() => tools.parse(props.def));
const view = computed(() => (parsed.value.ok ? viewOf(parsed.value.expr) : undefined));
const typeText = computed(() => (parsed.value.ok ? tools.typeText(parsed.value.expr, props.scope) : ''));
const children = computed(() => (view.value === undefined ? [] : childrenOf(view.value)));
const own = computed(() => problemsAt(props.problems, props.path));
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
</script>

<template>
  <div class="gin-expr-node" :class="[`kind-${view?.kind ?? 'unreadable'}`, { readonly }]" :data-path="path" :data-kind="view?.kind" data-testid="gin-expr-node">
    <div class="head">
      <UiSelect
        v-if="!readonly && view && view.kind !== 'other'" class="kind" :model-value="view.kind" :options="KIND_OPTIONS" :label="`${label}: kind`" hide-label size="sm"
        @update:model-value="swap($event)"
      />
      <UiBadge v-else tone="accent">{{ view ? exprLabel(view.kind) : 'Unreadable' }}</UiBadge>
      <span v-if="label !== 'Expression'" class="label">{{ label }}</span>
      <code v-if="typeText !== '' && typeText !== 'any'" class="type" title="What it evaluates to">→ {{ typeText }}</code>
      <UiIconButton v-if="!readonly && removable" class="remove" icon="x" size="sm" :label="`Remove ${label}`" @click="emit('remove')" />
    </div>
    <p v-if="readonly && comment !== ''" class="comment">// {{ comment }}</p>
    <UiInput v-if="!readonly && view" :model-value="comment" :label="`${label}: comment`" hide-label placeholder="Comment" size="sm" @update:model-value="scalar({ field: 'comment', text: $event })" />
    <p v-if="!parsed.ok" class="problem" role="alert">{{ parsed.problem }}</p>
    <p v-for="(problem, i) in own" :key="i" class="problem" :class="problem.severity" role="alert">{{ problem.message }}</p>

    <template v-if="view">
      <!-- a value: its type and the value, with the gin editors -->
      <div v-if="view.kind === 'new'" class="value">
        <GinTypeView v-if="!readonly" :model-value="newType" :label="`${label} type`" @update:model-value="scalar({ field: 'new-type', type: $event })" />
        <GinValueView :type="newType" :model-value="newValue" :readonly="readonly" :label="`${label} value`" @update:model-value="scalar({ field: 'new-value', value: $event })" />
      </div>

      <!-- a path: fields, calls and indexes -->
      <div v-else-if="view.kind === 'get' || view.kind === 'set'" class="path" data-testid="gin-expr-path">
        <template v-for="(step, i) in steps" :key="i">
          <span v-if="step.kind === 'prop'" class="step">
            <span v-if="i > 0" class="dot" aria-hidden="true">.</span>
            <code v-if="readonly" class="prop">{{ step.name }}</code>
            <UiInput v-else class="prop-input" :model-value="step.name" :label="i === 0 ? 'Variable' : `Field ${i + 1}`" hide-label size="sm" @update:model-value="scalar({ field: 'prop', step: i, name: $event })" />
          </span>
          <span v-else-if="step.kind === 'call'" class="step call">
            <code class="punct">(</code>
            <template v-if="!readonly">
              <UiInput
                v-for="[name] in step.args" :key="name" class="arg-input" :model-value="name" :label="`Argument ${name} name`" hide-label size="sm"
                @update:model-value="scalar({ field: 'arg', step: i, from: name, to: $event })"
              />
              <UiIconButton icon="plus" size="sm" label="Add argument" @click="list({ of: 'args', step: i }, { op: 'add' })" />
            </template>
            <code v-else class="punct">{{ step.args.map(([name]) => name).join(', ') }}</code>
            <code class="punct">)</code>
          </span>
          <code v-else class="punct">[ ]</code>
          <UiIconButton v-if="!readonly && steps.length > 1" icon="x" size="sm" :label="`Remove step ${i + 1}`" @click="list({ of: 'steps' }, { op: 'remove', index: i })" />
        </template>
        <UiMenu v-if="!readonly" :items="STEP_MENU" label="Add a step" @select="list({ of: 'steps' }, { op: 'add', step: $event })">
          <template #trigger="{ toggle, attrs }"><UiButton size="sm" variant="ghost" icon="plus" v-bind="attrs" @click="toggle">Step</UiButton></template>
        </UiMenu>
      </div>

      <!-- plain fields of the other kinds -->
      <div v-else-if="view.kind === 'define' && !readonly" class="names">
        <UiInput
          v-for="(v, i) in view.def.vars" :key="i" :model-value="v.name" :label="`Variable ${i + 1}`" size="sm"
          @update:model-value="scalar({ field: 'var', index: i, name: $event })"
        />
        <UiButton size="sm" variant="ghost" icon="plus" @click="list({ of: 'vars' }, { op: 'add' })">Variable</UiButton>
      </div>
      <div v-else-if="view.kind === 'loop'" class="names">
        <template v-if="readonly"><code class="punct">for {{ view.def.key ?? 'key' }}, {{ view.def.value ?? 'value' }}</code></template>
        <template v-else>
          <UiInput :model-value="view.def.key ?? ''" label="Key name" placeholder="key" size="sm" @update:model-value="scalar({ field: 'loop-key', name: $event })" />
          <UiInput :model-value="view.def.value ?? ''" label="Value name" placeholder="value" size="sm" @update:model-value="scalar({ field: 'loop-value', name: $event })" />
        </template>
      </div>
      <div v-else-if="view.kind === 'template'" class="template">
        <code v-if="readonly" class="template-text">{{ view.text }}</code>
        <UiTextarea v-else :model-value="view.text" label="Template" hint="{name} is replaced by the value of name" :rows="2" @update:model-value="scalar({ field: 'template', text: $event })" />
      </div>
      <div v-else-if="view.kind === 'flow'" class="names">
        <code v-if="readonly" class="punct">{{ view.def.action }}</code>
        <UiSelect v-else :model-value="view.def.action" :options="ACTION_OPTIONS" label="Action" size="sm" @update:model-value="scalar({ field: 'action', action: $event })" />
      </div>
      <div v-else-if="view.kind === 'native'" class="names">
        <code v-if="readonly" class="punct">{{ view.def.id }}</code>
        <UiInput v-else :model-value="view.def.id" label="Native id" placeholder="num.add" size="sm" @update:model-value="scalar({ field: 'native', id: $event })" />
      </div>
      <code v-else-if="view.kind === 'lambda'" class="type-code">{{ lambdaType }}</code>
      <UiCodeBlock v-else-if="view.kind === 'other'" :code="parsed.ok ? tools.code(parsed.expr) : ''" language="ts" :max-height="240" />

      <!-- children -->
      <div v-if="children.length > 0" class="children">
        <div v-for="child in children" :key="child.path" class="slot">
          <GinExprNode
            v-if="child.def" :def="child.def" :readonly="readonly" :path="join(child.path)" :problems="problems" :scope="scope" :label="child.label"
            :removable="canRemove(child)" @update="setChild(child, $event)" @remove="removeChild(child)"
          />
          <div v-else-if="!readonly" class="empty-slot">
            <span class="label">{{ child.label }}</span>
            <UiButton size="sm" variant="ghost" icon="plus" @click="fill(child)">Add</UiButton>
          </div>
        </div>
      </div>

      <!-- growing a node's lists -->
      <div v-if="!readonly" class="grow">
        <UiButton v-if="view.kind === 'block'" size="sm" variant="ghost" icon="plus" @click="list({ of: 'lines' }, { op: 'add' })">Step</UiButton>
        <UiButton v-if="view.kind === 'if'" size="sm" variant="ghost" icon="plus" @click="list({ of: 'branches' }, { op: 'add' })">Else if</UiButton>
        <template v-if="view.kind === 'switch'">
          <UiButton size="sm" variant="ghost" icon="plus" @click="list({ of: 'cases' }, { op: 'add' })">Case</UiButton>
          <UiButton
            v-for="n in view.def.cases.length" :key="n" size="sm" variant="ghost" icon="plus" @click="list({ of: 'equals', index: n - 1 }, { op: 'add' })"
          >
            Value for case {{ n }}
          </UiButton>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gin-expr-node { display: grid; gap: var(--space-2); min-width: 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.gin-expr-node .gin-expr-node { background: var(--surface-2); }
.gin-expr-node .gin-expr-node .gin-expr-node { background: var(--surface); }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
.kind { width: min(100%, 160px); }
.label { color: var(--text-dim); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.type { color: var(--text-faint); font: var(--text-xs) var(--mono); overflow-wrap: anywhere; }
.remove { margin-left: auto; }
.comment { margin: 0; color: var(--text-faint); font: var(--text-xs) var(--mono); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-xs); }
.problem.warning { color: var(--warn); }
.problem.info { color: var(--text-dim); }
.value { display: grid; gap: var(--space-2); min-width: 0; }
.path { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1); min-width: 0; }
.step { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; flex-wrap: wrap; }
.dot, .punct { color: var(--text-faint); font-family: var(--mono); }
.prop { font: var(--weight-medium) var(--text-sm) var(--mono); color: var(--text); }
.prop-input, .arg-input { width: 9rem; max-width: 100%; }
.names { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-2); }
.template-text { font: var(--text-sm) var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.type-code { font: var(--text-xs) var(--mono); color: var(--text-dim); overflow-wrap: anywhere; }
.children { display: grid; gap: var(--space-2); padding-left: var(--space-2); border-left: 2px solid var(--border); min-width: 0; }
.slot { min-width: 0; }
.empty-slot { display: flex; align-items: center; gap: var(--space-2); }
.grow { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.grow:empty { display: none; }
</style>
