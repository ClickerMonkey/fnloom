<script setup lang="ts">
/**
 * A gin expression, viewed or edited by one flag (`readonly`). Viewed, it reads as code (`GinCode`: one line per
 * statement, comments behind info icons, gin's problems marked on their lines). Edited, it reads as the same code with
 * its names, text and values as inputs in place (`GinExprNode`), and the plain code a tab away. The node under the
 * pointer or holding focus is the active one, which alone shows its menu button and step tools. Either way the header says what it evaluates to
 * (gin's `typeOf`, with the variables in `scope` typed) and how many problems gin found. Each edit is emitted as the
 * new definition (`update:modelValue`), problems and all, so a half-made expression is never lost.
 */
import type { ExprDef } from '@aeye/gin';
import type { GinExprDef, GinTypeDef } from '@harness/core';
import { computed, inject, provide, ref, watch } from 'vue';
import { UiBanner, UiSegmented, type SegmentOption } from '../ui/index.ts';
import GinCode from './components/GinCode.vue';
import GinExprNode from './components/GinExprNode.vue';
import { useCodeWidth } from './codeWidth.ts';
import { ExprEditor, EXPR_ACTIVE, EXPR_TOOLS, EXPR_WIDTH, sharedExprTools } from './state.ts';
import { GIN_TYPES, LOCAL_TYPES } from './types.ts';

const props = withDefaults(defineProps<{
  modelValue: GinExprDef | undefined;
  readonly?: boolean;
  /** The variables the expression may read, and their types. */
  scope?: Readonly<Record<string, GinTypeDef>>;
  label?: string;
}>(), { readonly: false, scope: () => ({}), label: 'Expression' });

const emit = defineEmits<{ 'update:modelValue': [def: GinExprDef] }>();
const types = inject(GIN_TYPES, LOCAL_TYPES);
const tools = inject(EXPR_TOOLS, sharedExprTools, true);
provide(EXPR_TOOLS, tools);
const editor = new ExprEditor(tools, types);
const active = ref<string | undefined>(undefined);
provide(EXPR_ACTIVE, active);
const code = ref<HTMLElement | null>(null);
const probe = ref<HTMLElement | null>(null);
// a few characters more than the code view keeps free, for the icons at the ends of lines
provide(EXPR_WIDTH, useCodeWidth(code, probe, 6));

/** Make the innermost node around an event's target the active one. */
function activate(event: Event): void {
  const node = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid="gin-expr-node"]') : null;
  if (node !== null) { active.value = node.dataset['path'] ?? ''; }
}
function hover(event: PointerEvent): void {
  if (event.pointerType === 'mouse') { activate(event); }
}
/**
 * The pointer leaving the code ends the active node while nothing holds focus. Focus elsewhere keeps it: it may be in
 * the node's own menu or comment box, which open outside the code.
 */
function leave(): void {
  if (document.activeElement === null || document.activeElement === document.body) { active.value = undefined; }
}

type Show = 'tree' | 'code';
const SHOWS: readonly SegmentOption<Show>[] = [{ value: 'tree', label: 'Edit' }, { value: 'code', label: 'Code' }];
const show = ref<Show>('tree');

watch(() => [props.modelValue, props.scope] as const, ([def, scope]) => { editor.show(def, scope); }, { immediate: true });
void types.need(Object.values(props.scope));

const errors = computed(() => editor.problems.value.filter((p) => p.severity === 'error').length);
const warnings = computed(() => editor.problems.value.length - errors.value);

function update(def: ExprDef): void {
  emit('update:modelValue', def);
}
</script>

<template>
  <div class="gin-expr-view" :class="{ readonly }" :data-readonly="readonly" data-testid="gin-expr-view">
    <div class="bar">
      <code class="result" title="What it evaluates to">→ <span data-testid="gin-expr-type">{{ editor.typeText.value || '—' }}</span></code>
      <span v-if="errors > 0" class="count danger">{{ errors }} {{ errors === 1 ? 'problem' : 'problems' }}</span>
      <span v-if="warnings > 0" class="count warn">{{ warnings }} {{ warnings === 1 ? 'note' : 'notes' }}</span>
      <UiSegmented v-if="!readonly" v-model="show" class="show" :options="SHOWS" :label="`${label}: show`" />
    </div>
    <UiBanner v-if="editor.unreadable.value !== ''" tone="danger">{{ editor.unreadable.value }}</UiBanner>
    <p v-if="!modelValue" class="dim">No expression.</p>
    <GinCode v-else-if="readonly || show === 'code'" :def="modelValue" :problems="editor.problems.value" />
    <div v-else ref="code" class="code" @focusin="activate" @pointerdown="activate" @pointerover="hover" @pointerleave="leave">
      <span ref="probe" class="probe" aria-hidden="true">0000000000</span>
      <GinExprNode :def="modelValue" :problems="editor.problems.value" :scope="editor.scope.value" :label="label" @update="update" />
    </div>
  </div>
</template>

<style scoped>
.gin-expr-view { display: grid; gap: var(--space-2); min-width: 0; }
.bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-3); min-width: 0; font-size: var(--text-xs); }
.result { color: var(--text-dim); font: var(--text-xs) var(--mono); overflow-wrap: anywhere; }
.show { margin-left: auto; }
.dim { margin: 0; color: var(--text-faint); }
/* the editor reads as code: monospace, on the code background, scrolling sideways before it overlaps */
.probe { position: absolute; visibility: hidden; white-space: pre; }
.code { position: relative; min-width: 0; padding: var(--space-2) var(--space-3); overflow-x: auto; border-radius: var(--radius); background: var(--code-bg); font: var(--text-sm)/1.55 var(--mono); }
.count { font-weight: var(--weight-medium); }
.count.danger { color: var(--danger); }
.count.warn { color: var(--warn); }
</style>
