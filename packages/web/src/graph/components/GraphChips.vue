<script setup lang="ts" generic="V extends string">
/**
 * A row of toggle chips for one filter: each value on or off, none picked meaning no filter. The label sits before
 * the chips and the row wraps.
 */
const props = defineProps<{ label: string; options: readonly { readonly value: V; readonly label: string }[]; testid?: string }>();
const model = defineModel<readonly V[]>({ required: true });

function toggle(value: V): void {
  model.value = model.value.includes(value) ? model.value.filter((v) => v !== value) : props.options.map((o) => o.value).filter((v) => v === value || model.value.includes(v));
}
</script>

<template>
  <fieldset class="chips" :data-testid="testid">
    <legend>{{ label }}</legend>
    <button v-for="option in options" :key="option.value" type="button" class="chip" :aria-pressed="model.includes(option.value)" @click="toggle(option.value)">{{ option.label }}</button>
  </fieldset>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 0; padding: 0; border: 0; min-width: 0; }
legend { float: left; margin-right: var(--space-2); font-size: var(--text-xs); color: var(--text-faint); min-width: 84px; }
.chip {
  height: 24px; padding: 0 var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); color: var(--text-dim);
  font: inherit; font-size: var(--text-xs); cursor: pointer;
}
.chip:hover { border-color: var(--border-strong); color: var(--text); }
.chip[aria-pressed='true'] { background: var(--accent-soft-strong); border-color: var(--accent); color: var(--text); }
.chip:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
</style>
