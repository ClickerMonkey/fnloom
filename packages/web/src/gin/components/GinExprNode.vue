<script setup lang="ts">
/**
 * One node of a gin expression, edited as code (`logic/expr-edit.ts` lays it out): it reads the way the code view
 * prints it, with its names, text and values as inputs in place. A node stays on one line while it fits and wraps
 * only past the code width, one statement per line, its parts one level in; position says what each part is, so there
 * are no labels. A keyword (`if`, `switch`, `for`, `let`, `fn`) opens the node's menu (change its kind, add a branch,
 * a case or a variable, add or take out an optional part, take the node out); a node with no keyword shows a small
 * menu button while it is the one being worked on (`EXPR_ACTIVE`), as do a path's step buttons. What a node evaluates
 * to is its tooltip, errors are marked on it and listed, notes and the comment wait behind icons, and a value's type
 * editor stays folded until asked for. Each change is emitted upward as the node's new definition.
 */
import type { ExprDef, Type } from '@aeye/gin';
import type { GinTypeDef, Json } from '@harness/core';
import { computed, inject, ref } from 'vue';
import { UiCodeBlock, UiIcon, UiIconButton, UiMenu } from '../../ui/index.ts';
import GinTypeView from '../GinTypeView.vue';
import GinValueView from '../GinValueView.vue';
import { canRemove, childOf, editRows, editShape, GROW_ACTIONS, isGrowAction, nodeMenu, type EditPiece, type EditShape, type NodeAction } from '../logic/expr-edit.ts';
import { EXPR_KINDS, FLOW_ACTIONS, marksWithin, problemsAt, removalOf, viewOf, withChild, withList, withScalar, type ExprChild, type ExprKind, type ExprList, type ExprProblem, type ListEdit, type ScalarEdit } from '../logic/expr.ts';
import { CODE_WIDTH } from '../logic/layout.ts';
import { EXPR_ACTIVE, EXPR_TOOLS, EXPR_WIDTH, sharedExprTools } from '../state.ts';
import GinIdent from './GinIdent.vue';
import GinNote from './GinNote.vue';

const props = withDefaults(defineProps<{
  def: ExprDef;
  /** Where this node is in the whole expression (`ifs.0.body`), for gin's problems. */
  path?: string;
  /** gin's problems with the whole expression. */
  problems?: readonly ExprProblem[];
  /** The variables in scope, typed. */
  scope?: ReadonlyMap<string, Type>;
  /** What holds the node, for screen readers and menus. */
  label?: string;
  /** Offer to take this node out (an optional slot, or an item of a list). */
  removable?: boolean;
  /** Indent levels, for whether it fits on a line. */
  depth?: number;
  /** On its parent's line (the parent fits on one): stay on one line too. */
  inline?: boolean;
  /** On a line of its own: a block or a define shows its lines bare, with no braces. */
  statement?: boolean;
}>(), { path: '', problems: () => [], scope: () => new Map(), label: 'Expression', removable: false, depth: 0, inline: false, statement: true });

const emit = defineEmits<{ update: [def: ExprDef]; remove: [] }>();
const tools = inject(EXPR_TOOLS, sharedExprTools, true);
const active = inject(EXPR_ACTIVE, ref<string | undefined>(undefined));
const width = inject(EXPR_WIDTH, ref(CODE_WIDTH));

const parsed = computed(() => tools.parse(props.def));
const view = computed(() => (parsed.value.ok ? viewOf(parsed.value.value) : undefined));
const shape = computed<EditShape>(() => (props.inline ? 'inline' : editShape(props.def, tools, props.depth, width.value, marksWithin(props.problems, props.path))));
const rows = computed(() => (view.value === undefined ? [] : editRows(view.value, shape.value, props.statement)));
const menu = computed(() => (view.value === undefined ? [] : nodeMenu(view.value, props.removable)));
/** Whether a keyword opens the menu, so the node needs no menu button. */
const keywordMenu = computed(() => rows.value[0]?.pieces.some((piece) => piece.kind === 'keyword' && piece.menu) === true);
const isActive = computed(() => active.value === props.path);
const typeText = computed(() => (parsed.value.ok ? tools.typeText(parsed.value.value, props.scope) : ''));
const own = computed(() => problemsAt(props.problems, props.path));
const errors = computed(() => own.value.filter((problem) => problem.severity === 'error'));
const notes = computed(() => own.value.filter((problem) => problem.severity !== 'error'));
const warned = computed(() => notes.value.some((problem) => problem.severity === 'warning'));
const notesOpen = ref(false);
const notesLabel = computed(() => (notesOpen.value ? 'Hide notes' : notes.value.map((problem) => problem.message).join(' ')));
const errorsOpen = ref(false);
const firstVariable = computed(() => [...props.scope.keys()][0] ?? 'value');
const comment = computed(() => (typeof props.def.comment === 'string' ? props.def.comment : ''));
const typeOpen = ref(false);
const newType = computed<GinTypeDef | undefined>(() => (view.value?.kind === 'new' ? view.value.def.type : undefined));
const newValue = computed<Json | undefined>(() => (view.value?.kind === 'new' ? view.value.value : undefined));
/** A plain literal on a line is typed in place as code (text in quotes, a number, true or false); others use the value editor. */
const plain = computed<'text' | 'num' | 'bool' | undefined>(() => {
  const type = newType.value?.name;
  return shape.value === 'inline' && (type === 'text' || type === 'num' || type === 'bool') ? type : undefined;
});
/** A number as typed, kept while it isn't one yet (`1.`, `-`). */
const numDraft = ref<string | undefined>(undefined);
const numText = computed(() => numDraft.value ?? (typeof newValue.value === 'number' ? String(newValue.value) : ''));
function setNum(text: string): void {
  numDraft.value = text;
  const value = Number(text);
  if (text.trim() !== '' && Number.isFinite(value)) { scalar({ field: 'new-value', value }); }
}
function setBool(event: Event): void {
  if (event.target instanceof HTMLSelectElement) { scalar({ field: 'new-value', value: event.target.value === 'true' }); }
}
/** The tooltip: what it evaluates to (the root's is the card header's). */
const evaluates = computed(() => (props.path === '' || typeText.value === '' || typeText.value === 'any' ? undefined : `Evaluates to ${typeText.value}`));
const join = (sub: string): string => (props.path === '' ? sub : `${props.path}.${sub}`);
const ACTION_OPTIONS = FLOW_ACTIONS;

function blank(): ExprDef {
  return tools.blank('new', firstVariable.value);
}
function scalar(edit: ScalarEdit): void {
  if (view.value !== undefined) { emit('update', withScalar(view.value, edit)); }
}
function list(of: ExprList, edit: ListEdit): void {
  if (view.value !== undefined) { emit('update', withList(view.value, of, edit, blank)); }
}
function setChild(child: ExprChild, def: ExprDef | undefined): void {
  if (view.value !== undefined) { emit('update', withChild(view.value, child.slot, def)); }
}
function removeChild(child: ExprChild): void {
  const removal = view.value === undefined ? undefined : removalOf(view.value, child);
  if (removal === undefined) { return; }
  if (removal.by === 'empty') { setChild(child, undefined); } else { list(removal.list, { op: 'remove', index: removal.index }); }
}
function canTakeOut(child: ExprChild): boolean {
  return view.value !== undefined && canRemove(view.value, child);
}

function act(action: NodeAction): void {
  const current = view.value;
  if (current === undefined) { return; }
  if (action.startsWith('kind:')) {
    const kind = action.slice('kind:'.length);
    if (isKind(kind)) { emit('update', tools.blank(kind, firstVariable.value)); }
    return;
  }
  if (action.startsWith('fill:') || action.startsWith('clear:')) {
    const fill = action.startsWith('fill:');
    const child = childOf(current, action.slice(fill ? 'fill:'.length : 'clear:'.length));
    if (child !== undefined) { setChild(child, fill ? blank() : undefined); }
    return;
  }
  if (isGrowAction(action)) {
    const [of, edit] = GROW_ACTIONS[action];
    list(of, edit);
    return;
  }
  if (action === 'type') { typeOpen.value = !typeOpen.value; return; }
  if (action === 'remove') { emit('remove'); }
}

function isKind(kind: string): kind is ExprKind {
  return EXPR_KINDS.some((known) => known.kind === kind);
}
function isAction(action: string): action is (typeof FLOW_ACTIONS)[number] {
  return FLOW_ACTIONS.some((known) => known === action);
}
function setAction(event: Event): void {
  if (event.target instanceof HTMLSelectElement && isAction(event.target.value)) { scalar({ field: 'action', action: event.target.value }); }
}

/** The props of a child node in its place. */
function childProps(piece: Extract<EditPiece, { kind: 'child' }>, indent: boolean): {
  def: ExprDef; path: string; problems: readonly ExprProblem[]; scope: ReadonlyMap<string, Type>; label: string; removable: boolean; depth: number; inline: boolean; statement: boolean;
} {
  return {
    def: piece.child.def ?? blank(), path: join(piece.child.path), problems: props.problems, scope: props.scope, label: piece.child.label,
    removable: canTakeOut(piece.child), depth: props.depth + (indent ? 1 : 0), inline: shape.value === 'inline', statement: piece.statement,
  };
}
</script>

<template>
  <component
    :is="shape === 'inline' ? 'span' : 'div'" class="gin-expr-node" :class="[shape, `kind-${view?.kind ?? 'unreadable'}`, { active: isActive, bad: errors.length > 0 || !parsed.ok }]"
    :data-path="path" :data-kind="view?.kind" :title="evaluates" data-testid="gin-expr-node"
  >
    <span v-if="!view" class="unreadable" role="alert">{{ parsed.ok ? '' : parsed.problem }}</span>
    <component :is="shape === 'inline' ? 'span' : 'div'" v-for="(line, r) in rows" :key="r" class="row" :class="{ head: r === 0, ind: line.indent }">
      <template v-for="(piece, i) in line.pieces" :key="i">
        <UiMenu v-if="piece.kind === 'keyword' && piece.menu" :items="menu" :label="`${label}: change`" align="start" @select="act">
          <template #trigger="{ toggle, attrs }"><button type="button" class="kw kw-menu" v-bind="attrs" @click="toggle">{{ piece.text }}</button></template>
        </UiMenu>
        <code v-else-if="piece.kind === 'keyword'" class="kw">{{ piece.text }}</code>
        <code v-else-if="piece.kind === 'punct'" class="punct">{{ piece.text }}</code>
        <GinExprNode
          v-else-if="piece.kind === 'child'" v-bind="childProps(piece, line.indent)"
          @update="setChild(piece.child, $event)" @remove="removeChild(piece.child)"
        />
        <GinIdent
          v-else-if="piece.kind === 'name'" :model-value="piece.value" :label="piece.label" :placeholder="piece.placeholder"
          @update:model-value="scalar(piece.edit($event))"
        />
        <span v-else-if="piece.kind === 'literal' && plain === 'text'" class="template">
          <code class="str">"</code><GinIdent :model-value="typeof newValue === 'string' ? newValue : ''" :label="`${label} value`" tone="string" @update:model-value="scalar({ field: 'new-value', value: $event })" /><code class="str">"</code>
        </span>
        <GinIdent
          v-else-if="piece.kind === 'literal' && plain === 'num'" :model-value="numText" :label="`${label} value`" placeholder="0" tone="number" inputmode="decimal"
          @update:model-value="setNum" @blur="numDraft = undefined"
        />
        <select v-else-if="piece.kind === 'literal' && plain === 'bool'" class="kw kw-select" :value="newValue === true ? 'true' : 'false'" :aria-label="`${label} value`" @change="setBool">
          <option value="true">true</option><option value="false">false</option>
        </select>
        <GinValueView
          v-else-if="piece.kind === 'literal'" class="literal" :class="{ wide: shape === 'block' }" :type="newType" :model-value="newValue" :label="`${label} value`"
          :inline="shape === 'inline'" @update:model-value="scalar({ field: 'new-value', value: $event })"
        />
        <span v-else-if="piece.kind === 'template'" class="template">
          <code class="str">`</code><GinIdent :model-value="piece.text" label="Template" placeholder="Hello {name}" tone="string" @update:model-value="scalar({ field: 'template', text: $event })" /><code class="str">`</code>
        </span>
        <select v-else-if="piece.kind === 'action'" class="kw kw-select" :value="piece.action" aria-label="Action" @change="setAction">
          <option v-for="action in ACTION_OPTIONS" :key="action" :value="action">{{ action }}</option>
        </select>
        <code v-else-if="piece.kind === 'type'" class="type">{{ piece.text }}</code>
        <UiCodeBlock v-else-if="piece.kind === 'code'" class="other" :code="parsed.ok ? tools.code(parsed.value) : ''" language="ts" :max-height="240" />
        <UiIconButton v-else-if="piece.kind === 'add-arg'" class="tool" icon="plus" size="sm" label="Add an argument" @click="list({ of: 'args', step: piece.step }, { op: 'add' })" />
        <UiIconButton v-else-if="piece.kind === 'add-equals'" class="tool" icon="plus" size="sm" :label="`Another value for case ${piece.index + 1}`" @click="list({ of: 'equals', index: piece.index }, { op: 'add' })" />
        <UiIconButton v-else-if="piece.kind === 'remove-step'" class="tool" icon="x" size="sm" :label="`Take out step ${piece.step + 1}`" @click="list({ of: 'steps' }, { op: 'remove', index: piece.step })" />
        <button v-else-if="piece.kind === 'add-line'" type="button" class="add-line" @click="list({ of: 'lines' }, { op: 'add' })"><UiIcon name="plus" :size="12" /> line</button>
      </template>
      <span v-if="r === 0" class="ends">
        <UiIconButton
          v-if="errors.length > 0 && shape === 'inline'" icon="error" size="sm" class="errors-toggle" :label="errors.map((p) => p.message).join(' ')" :pressed="errorsOpen"
          @click="errorsOpen = !errorsOpen"
        />
        <UiIconButton
          v-if="notes.length > 0" :icon="warned ? 'warning' : 'info'" size="sm" class="notes-toggle" :class="{ warn: warned }" :label="notesLabel" :pressed="notesOpen"
          data-testid="gin-expr-notes" @click="notesOpen = !notesOpen"
        />
        <GinNote v-if="view && (comment !== '' || isActive)" :model-value="comment" :label="`Comment on ${label}`" editable @update:model-value="scalar({ field: 'comment', text: $event })" />
        <UiMenu v-if="view && !keywordMenu" :items="menu" :label="`${label}: change`" align="start" @select="act">
          <template #trigger="{ toggle, attrs }">
            <UiIconButton class="tool handle" icon="chevron-down" size="sm" :label="`Change ${label.toLowerCase()}`" v-bind="attrs" data-testid="gin-expr-menu" @click="toggle" />
          </template>
        </UiMenu>
      </span>
    </component>
    <template v-if="shape === 'block' || errorsOpen"><span v-for="(problem, i) in errors" :key="i" class="problem" role="alert">{{ problem.message }}</span></template>
    <template v-if="notesOpen"><span v-for="(problem, i) in notes" :key="`note-${i}`" class="problem" :class="problem.severity">{{ problem.message }}</span></template>
    <div v-if="view?.kind === 'new' && typeOpen" class="type-editor">
      <GinTypeView :model-value="newType" :label="`${label} type`" @update:model-value="scalar({ field: 'new-type', type: $event })" />
    </div>
  </component>
</template>

<style scoped>
/* one line: its tokens stay on it (the shape chose one line only where it fits; past that the code scrolls); wrapped: one row per line of code */
.gin-expr-node.inline { display: inline-flex; flex-wrap: nowrap; white-space: nowrap; align-items: center; min-width: 0; }
.gin-expr-node.block { display: grid; min-width: 0; }
/* rows as far apart as the read-only code's lines, so editing and viewing read as the same code */
.row { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; min-height: 1.55em; }
.inline > .row { display: contents; }
.row.ind { padding-left: 2ch; border-left: 1px solid var(--border); margin-left: 0.5ch; }
/* a wrapped child on a line takes the lines below it */
.row > .gin-expr-node.block { flex-basis: 100%; }
.gin-expr-node.bad > .row.head { text-decoration: underline wavy var(--danger); text-decoration-skip-ink: none; text-underline-offset: 3px; }
.kw { color: var(--accent); font: inherit; white-space: pre; }
.kw-menu, .kw-select {
  margin: 0; padding: 0 1px; border: 1px solid transparent; border-radius: var(--radius-sm); background: transparent; color: var(--accent); font: inherit; cursor: pointer;
}
.kw-menu:hover, .kw-select:hover { border-color: var(--border); }
.kw-menu:focus-visible, .kw-select:focus-visible { outline: none; box-shadow: var(--ring); }
.kw-select { appearance: none; }
.punct { color: var(--text-dim); font: inherit; white-space: pre; }
.str { color: light-dark(oklch(0.5 0.13 150), oklch(0.78 0.12 150)); font: inherit; }
.type { color: light-dark(oklch(0.5 0.12 290), oklch(0.78 0.1 290)); font: inherit; overflow-wrap: anywhere; }
.template { display: inline-flex; align-items: center; min-width: 0; }
.literal { flex: 0 1 auto; min-width: 4ch; max-width: 24rem; font-family: var(--font); }
.literal.wide { flex: 1 1 16rem; max-width: none; }
.other { flex-basis: 100%; }
.ends { display: inline-flex; align-items: center; flex: none; }
.ends:empty { display: none; }
/* the tools show on the node being worked on only (focusing anything in a node makes it that node), so code stays quiet */
.gin-expr-node:not(.active) > .row > .tool, .gin-expr-node:not(.active) > .row > .ends .tool:not([aria-expanded='true']) { display: none; }
.add-line {
  display: inline-flex; align-items: center; gap: 2px; margin: 1px 0; padding: 0 var(--space-1); border: 0; border-radius: var(--radius-sm); background: transparent;
  color: var(--text-faint); font: inherit; font-size: var(--text-xs); cursor: pointer;
}
.add-line:hover { color: var(--accent); background: var(--accent-soft); }
.add-line:focus-visible { outline: none; box-shadow: var(--ring); }
.notes-toggle { color: var(--text-dim); }
.notes-toggle.warn { color: var(--warn); }
.errors-toggle { color: var(--danger); }
.problem { flex-basis: 100%; margin: 0; color: var(--danger); font: var(--text-xs) var(--font); }
.problem.warning { color: var(--warn); }
.problem.info { color: var(--text-dim); }
.unreadable { color: var(--danger); font-size: var(--text-xs); }
.type-editor { flex-basis: 100%; min-width: 0; margin: var(--space-1) 0; font-family: var(--font); }
</style>
