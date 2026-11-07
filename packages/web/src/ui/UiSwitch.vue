<script setup lang="ts">
/** An on/off switch with its label and an optional description (`v-model` is on). */
import { useId } from 'vue';

withDefaults(defineProps<{ label: string; description?: string; disabled?: boolean }>(), { description: '', disabled: false });
const model = defineModel<boolean>({ required: true });
const id = useId();
</script>

<template>
  <div class="ui-switch" :class="{ disabled }">
    <div class="text">
      <label :for="id" class="label">{{ label }}</label>
      <p v-if="description !== ''" :id="`${id}-desc`" class="description">{{ description }}</p>
    </div>
    <button
      :id="id" type="button" role="switch" class="track" :aria-checked="model ? 'true' : 'false'" :disabled="disabled"
      :aria-describedby="description === '' ? undefined : `${id}-desc`" @click="model = !model"
    >
      <span class="thumb" />
    </button>
  </div>
</template>

<style scoped>
.ui-switch { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-width: 0; }
.ui-switch.disabled { opacity: 0.55; }
.text { min-width: 0; }
.label { font-weight: var(--weight-medium); }
.description { margin: 2px 0 0; color: var(--text-dim); font-size: var(--text-sm); }
.track {
  position: relative; flex: none; width: 40px; height: 24px; padding: 0; border: 0; border-radius: var(--radius-full);
  background: var(--surface-3); transition: background-color var(--medium) var(--ease);
}
.track[aria-checked='true'] { background: var(--accent); }
.track:focus-visible { outline: none; box-shadow: var(--ring); }
.thumb {
  position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: var(--shadow-sm);
  transition: transform var(--medium) var(--spring);
}
.track[aria-checked='true'] .thumb { transform: translateX(16px); }
</style>
