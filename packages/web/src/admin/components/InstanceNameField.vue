<script setup lang="ts">
/**
 * The instance name of a service being added (`linear`): made from its label until the admin edits it. It names the
 * instance and prefixes what it adds (an MCP server's fns are `<instance>_<tool>`), so it can't change later.
 */
import { ref, watch } from 'vue';
import { UiInput } from '../../ui/index.ts';
import { instanceNameOf } from '../logic/remote-config.ts';

const props = withDefaults(defineProps<{ label: string; hint?: string; error?: string }>(), { hint: '', error: '' });
const name = defineModel<string>({ required: true });
const edited = ref(name.value !== '');

watch(() => props.label, (label) => { if (!edited.value) { name.value = instanceNameOf(label) ?? ''; } }, { immediate: true });

function type(text: string): void {
  edited.value = true;
  name.value = text;
}
</script>

<template>
  <UiInput
    :model-value="name" label="Instance name" required :hint="hint" placeholder="linear"
    :error="error === '' ? '' : 'Lowercase letters, digits and dashes, starting with a letter.'" data-testid="instance-name" @update:model-value="type"
  />
</template>
