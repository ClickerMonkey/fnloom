<script setup lang="ts">
/**
 * The hub's display name, for admins: the name everyone sees (the brand, the sign-in page, the tab title, the install
 * name, notification titles). Saving shows the new name in every open tab; "Use default" clears the setting, going
 * back to the hub's HARNESS_NAME setting or the default.
 */
import type { HubNameSource } from '@harness/core';
import { ref, watch } from 'vue';
import { checkHubName, NAME_SOURCE_WORDS } from '../state/identity.ts';
import { UiBanner, UiButton, UiCard, UiInput } from '../ui/index.ts';

const props = defineProps<{
  /** The name in use. */
  name: string;
  /** Where it came from; undefined until the hub answers. */
  source: HubNameSource | undefined;
  busy: boolean;
  /** Why the last save failed; '' when it worked. */
  problem: string;
}>();
const emit = defineEmits<{ save: [name: string | null] }>();

const draft = ref(props.name);
const error = ref('');
watch(() => props.name, (name) => { draft.value = name; error.value = ''; });

function save(): void {
  const checked = checkHubName(draft.value);
  error.value = checked.ok ? '' : checked.problem;
  if (checked.ok) { emit('save', checked.name); }
}
</script>

<template>
  <UiCard title="Hub name" subtitle="What everyone sees: the brand, the sign-in page, the tab title, the install name and notifications." data-testid="hub-name-card">
    <form class="form" novalidate @submit.prevent="save">
      <UiInput
        v-model="draft" label="Name" name="hub-name" required :error="error"
        :hint="source === undefined ? '' : NAME_SOURCE_WORDS[source]" data-testid="hub-name-input"
      />
      <div class="actions">
        <UiButton type="submit" variant="primary" :loading="busy" :disabled="draft.trim() === name" data-testid="hub-name-save">Save</UiButton>
        <UiButton v-if="source === 'setting'" variant="ghost" :disabled="busy" data-testid="hub-name-reset" @click="emit('save', null)">Use default</UiButton>
      </div>
    </form>
    <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
  </UiCard>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
