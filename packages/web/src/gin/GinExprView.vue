<script setup lang="ts">
/**
 * A gin expression, viewed or edited by one flag (`readonly`): the expression as a tree of its nodes (each with an
 * editor for its kind), what it evaluates to (gin's `typeOf`, with the variables in `scope` typed), gin's problems
 * with it, and the expression as gin prints it as code, a tab away. Each edit is emitted as the new definition
 * (`update:modelValue`), problems and all, so a half-made expression is never lost.
 */
import type { ExprDef } from '@aeye/gin';
import type { GinExprDef, GinTypeDef } from '@harness/core';
import { computed, inject, provide, ref, watch } from 'vue';
import { UiBanner, UiCodeBlock, UiSegmented, type SegmentOption } from '../ui/index.ts';
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
const SHOWS: readonly SegmentOption<Show>[] = [{ value: 'tree', label: 'Expression' }, { value: 'code', label: 'Code' }];
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
      <span class="result">
        <span class="dim">Gives</span>
        <code data-testid="gin-expr-type">{{ editor.typeText.value || '—' }}</code>
        <span v-if="errors > 0" class="count danger">{{ errors }} {{ errors === 1 ? 'problem' : 'problems' }}</span>
        <span v-if="warnings > 0" class="count warn">{{ warnings }} {{ warnings === 1 ? 'note' : 'notes' }}</span>
      </span>
      <UiSegmented v-model="show" :options="SHOWS" :label="`${label}: show`" />
    </div>
    <UiBanner v-if="editor.unreadable.value !== ''" tone="danger">{{ editor.unreadable.value }}</UiBanner>
    <template v-if="show === 'tree'">
      <GinExprNode
        v-if="modelValue" :def="modelValue" :readonly="readonly" :problems="editor.problems.value" :scope="editor.scope.value" :label="label"
        @update="update"
      />
      <p v-else class="dim">No expression.</p>
    </template>
    <UiCodeBlock v-else :code="editor.code.value" language="ts" :filename="label" :max-height="420" />
  </div>
</template>

<style scoped>
.gin-expr-view { display: grid; gap: var(--space-3); min-width: 0; }
.bar { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2); }
.result { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; font-size: var(--text-sm); }
.result code { padding: 1px 6px; border-radius: 5px; background: var(--code-bg); font: var(--text-xs) var(--mono); overflow-wrap: anywhere; }
.dim { color: var(--text-faint); }
.count { font-size: var(--text-xs); font-weight: var(--weight-medium); }
.count.danger { color: var(--danger); }
.count.warn { color: var(--warn); }
</style>
