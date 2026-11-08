<script setup lang="ts">
/**
 * A gin type, viewed or edited by one flag (`readonly`). Viewing draws the type as a tree with its options,
 * constraints and docs, under the type as gin prints it, with its definition (JSON) a tab away. Editing adds,
 * removes, renames and reorders fields, and changes kinds and options; every change is checked live by gin (it builds
 * the type and reads its definition back), and each one gin accepts is emitted as the new definition
 * (`update:modelValue`). Named types it refers to are loaded from the hub (`GIN_TYPES`) so they can be read.
 */
import type { GinTypeDef } from '@harness/core';
import { g } from '@harness/sdk';
import { computed, inject, ref, watch } from 'vue';
import { UiBanner, UiCodeBlock, UiSegmented, type SegmentOption } from '../ui/index.ts';
import GinTypeNode from './components/GinTypeNode.vue';
import type { TypeShape } from './logic/typedef.ts';
import { TypeEditor } from './state.ts';
import { GIN_TYPES, LOCAL_TYPES } from './types.ts';

const props = withDefaults(defineProps<{
  modelValue: GinTypeDef | undefined;
  readonly?: boolean;
  /** What the type is (`Args`, `Config`), for labels. */
  label?: string;
}>(), { readonly: false, label: 'Type' });

const emit = defineEmits<{ 'update:modelValue': [def: GinTypeDef] }>();
const types = inject(GIN_TYPES, LOCAL_TYPES);
const editor = new TypeEditor(props.modelValue, g, types);

type Show = 'tree' | 'json';
const SHOWS: readonly SegmentOption<Show>[] = [{ value: 'tree', label: 'Type' }, { value: 'json', label: 'Definition' }];
const show = ref<Show>('tree');

async function load(def: GinTypeDef | undefined): Promise<void> {
  if (def !== undefined && await types.need([def]) && def === props.modelValue) { editor.read(def); }
}
void load(props.modelValue);
watch(() => props.modelValue, (def) => { editor.accept(def); void load(def); });

const checked = computed(() => editor.checked.value);
const problems = computed(() => (checked.value?.ok === false ? checked.value.problems : []));
const code = computed(() => (checked.value?.ok === true ? checked.value.code : ''));
const json = computed(() => JSON.stringify(checked.value?.ok === true ? checked.value.def : props.modelValue ?? null, null, 2));
/** A problem not tied to one node (gin refusing the whole type). */
const whole = computed(() => problems.value.filter((p) => p.path === '').map((p) => p.message));

function update(shape: TypeShape): void {
  const changed = editor.update(shape);
  if (changed !== undefined) { emit('update:modelValue', changed.def); }
}
</script>

<template>
  <div class="gin-type-view" :class="{ readonly }" :data-readonly="readonly" data-testid="gin-type-view">
    <div class="bar">
      <code v-if="code !== ''" class="code" data-testid="gin-type-code">{{ code }}</code>
      <span v-else class="code dim">{{ editor.unreadable.value || 'Not checked yet' }}</span>
      <UiSegmented v-model="show" :options="SHOWS" :label="`${label}: show`" />
    </div>
    <UiBanner v-for="message in whole" :key="message" tone="danger">{{ message }}</UiBanner>
    <template v-if="show === 'tree'">
      <GinTypeNode
        v-if="editor.shape.value" :shape="editor.shape.value" :readonly="readonly" :label="label" :problems="problems" @update="update"
      />
      <p v-else class="dim">{{ editor.unreadable.value || 'No type.' }}</p>
    </template>
    <UiCodeBlock v-else :code="json" language="json" :filename="`${label} definition`" :max-height="420" />
  </div>
</template>

<style scoped>
.gin-type-view { display: grid; gap: var(--space-3); min-width: 0; container-type: inline-size; }
.bar { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); justify-content: space-between; }
.code { flex: 1 1 200px; min-width: 0; padding: var(--space-1) var(--space-2); border-radius: var(--radius); background: var(--code-bg); font: var(--text-xs) var(--mono); overflow-wrap: anywhere; }
.dim { color: var(--text-faint); }
</style>
