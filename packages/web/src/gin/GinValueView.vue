<script setup lang="ts">
/**
 * A value of a gin type, edited or viewed by one flag (`readonly`). Editing draws an input for every gin type,
 * nested (text, numbers, switches, choices, dates, durations, colours, lists, maps, tuples, objects, nullables,
 * unions, named types and JSON), checks the value live with gin, and emits `update:modelValue` with each edit that
 * fits the type (`problems` says what doesn't). Viewing draws the value by its shape. Either way a named type uses
 * its system's own component when there is one (`GIN_INPUTS`), and the named types the type refers to are loaded
 * from the hub first (`GIN_TYPES`).
 */
import type { Json } from '@harness/core';
import { inject, watch } from 'vue';
import GinInput from './components/GinInput.vue';
import GinValueNode from './components/GinValueNode.vue';
import type { FormProblem } from './logic/form.ts';
import { ValueEditor } from './state.ts';
import { GIN_TYPES, LOCAL_TYPES } from './types.ts';

const props = withDefaults(defineProps<{
  /** The gin type definition (`GinTypeDef`). */
  type: unknown;
  modelValue?: Json | undefined;
  /** View the value instead of editing it. */
  readonly?: boolean;
  /** What the value is, when it isn't an object (an object's fields carry their own labels). */
  label?: string;
  /** On a line of code: a one-line value without its label or hint (the hint is its tooltip). */
  inline?: boolean;
}>(), { modelValue: undefined, readonly: false, label: 'Value', inline: false });

const emit = defineEmits<{ 'update:modelValue': [value: Json]; problems: [problems: readonly FormProblem[]] }>();
const types = inject(GIN_TYPES, LOCAL_TYPES);
const editor = new ValueEditor(props.type, props.modelValue, types);

/** Load the named types the type refers to; once they arrive, the type is read again with their shapes. */
async function load(type: unknown): Promise<void> {
  if (await types.need([type]) && type === props.type) { editor.retype(type); }
}
void load(props.type);
watch(() => props.type, (type) => { editor.retype(type); void load(type); });
watch(() => props.modelValue, (value) => { editor.accept(value); });
watch(() => editor.form.value.problems.value, (problems) => { emit('problems', problems); });

function update(draft: Parameters<ValueEditor['update']>[0]): void {
  const changed = editor.update(draft);
  if (changed !== undefined) { emit('update:modelValue', changed.value); }
}
</script>

<template>
  <div class="gin-value-view" :class="{ readonly }" :data-readonly="readonly" data-testid="gin-value-view">
    <GinValueNode v-if="readonly" :node="editor.form.value.node" :value="modelValue" :label="label" />
    <GinInput
      v-else :node="editor.form.value.node" :draft="editor.form.value.draft.value" path="" :problems="editor.form.value.problems.value" :label="label"
      :required="editor.form.value.node.kind !== 'obj'" :inline="inline" @update="update"
    />
  </div>
</template>

<style scoped>
.gin-value-view { min-width: 0; container-type: inline-size; }
</style>
