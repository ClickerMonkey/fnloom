<script setup lang="ts">
/**
 * Setting an actor setting's value: which actor (only the kinds it applies to), then a form made from the setting's
 * type, starting from the actor's current value.
 */
import type { ActorId, Json } from '@harness/core';
import { computed, ref, watch } from 'vue';
import GinForm from '../../chat/forms/GinForm.vue';
import { UiBanner, UiDialog, UiSelect, type SelectOption } from '../../ui/index.ts';
import type { ActorOption } from '../state/actors.ts';
import type { SettingEntry } from '../state/settings.ts';

const props = withDefaults(defineProps<{
  entry: SettingEntry | undefined;
  actors: readonly ActorOption[];
  actor?: ActorId | undefined;
  busy?: boolean;
  problem?: string;
}>(), { actor: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [actor: ActorId, value: Json] }>();

const chosen = ref<string>('');
const choices = computed<readonly SelectOption<string>[]>(() => [{ value: '', label: 'Choose who…' }, ...props.actors.map((a) => ({ value: a.id, label: `${a.name} (${a.kind})` }))]);
const target = computed(() => props.actors.find((a) => a.id === chosen.value));
const current = computed(() => props.entry?.values.find((v) => v.actor === target.value?.id)?.value);

watch(open, (isOpen) => { if (isOpen) { chosen.value = props.actor ?? ''; } });

function save(value: Json): void {
  if (target.value !== undefined) { emit('save', target.value.id, value); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="entry ? `Set ${entry.view.decl.name}` : 'Set'" :description="entry?.view.decl.description ?? ''" width="560px">
    <div v-if="entry" class="body" data-testid="setting-form">
      <UiSelect v-model="chosen" :options="choices" label="On" />
      <GinForm
        v-if="target" :key="target.id" :type="entry.view.decl.type" :initial="current" submit-label="Save" :busy="busy" label="Value"
        @submit="save" @cancel="open = false"
      />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </div>
  </UiDialog>
</template>

<style scoped>
.body { display: grid; gap: var(--space-4); }
</style>
