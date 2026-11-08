<script setup lang="ts">
/**
 * A gin expression, viewed or edited by one flag (`readonly`). Viewed, it reads as code (`GinCode`: one line per
 * statement, comments behind info icons, gin's problems marked on their lines). Edited, it is a dense tree of its
 * nodes (each with an editor for its kind), with the code a tab away. Either way the header says what it evaluates to
 * (gin's `typeOf`, with the variables in `scope` typed) and how many problems gin found. Each edit is emitted as the
 * new definition (`update:modelValue`), problems and all, so a half-made expression is never lost.
 */
import type { ExprDef } from '@aeye/gin';
import type { GinExprDef, GinTypeDef } from '@harness/core';
import { computed, inject, provide, ref, watch } from 'vue';
import { UiBanner, UiSegmented, type SegmentOption } from '../ui/index.ts';
import GinCode from './components/GinCode.vue';
import GinExprNode from './components/GinExprNode.vue';
import { ExprEditor, EXPR_TOOLS, sharedExprTools } from './state.ts';
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
    <GinExprNode v-else :def="modelValue" :problems="editor.problems.value" :scope="editor.scope.value" :label="label" @update="update" />
  </div>
</template>

<style scoped>
.gin-expr-view { display: grid; gap: var(--space-2); min-width: 0; }
.bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-1) var(--space-3); min-width: 0; font-size: var(--text-xs); }
.result { color: var(--text-dim); font: var(--text-xs) var(--mono); overflow-wrap: anywhere; }
.show { margin-left: auto; }
.dim { margin: 0; color: var(--text-faint); }
.count { font-weight: var(--weight-medium); }
.count.danger { color: var(--danger); }
.count.warn { color: var(--warn); }
</style>
