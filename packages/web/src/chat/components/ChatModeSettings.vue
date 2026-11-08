<script setup lang="ts" generic="C extends ChatModeConfig | ContextorConfig">
/**
 * One of a chat's two prompt choices, the chat mode or the contextor: the agent's own, or one variant for this chat
 * with its settings edited by the gin value editor (read off core's schema). A change of variant applies at once with
 * its defaults; edited settings apply with Save, once they are valid. `null` goes back to the agent's.
 */
import type { ChatModeConfig, ContextorConfig, Json } from '@harness/core';
import { computed, ref, shallowRef, watch } from 'vue';
import GinValueView from '../../gin/GinValueView.vue';
import { UiButton, UiSelect, type SelectOption } from '../../ui/index.ts';
import { settingsValue, type VariantChoice } from '../logic/modes.ts';

const props = withDefaults(defineProps<{
  label: string;
  /** This chat's choice; undefined when it follows the agent's. */
  value: C | undefined;
  choices: readonly VariantChoice<C['type']>[];
  /** The config a variant makes with its defaults. */
  defaults: (type: C['type']) => C;
  /** A variant's config from its edited settings, or undefined when they aren't valid. */
  read: (type: C['type'], settings: Json) => C | undefined;
  busy?: boolean;
  testid: string;
}>(), { busy: false });
const emit = defineEmits<{ change: [config: C | null] }>();

/** The agent's own choice, in the picker. */
const AGENT = 'agent';
type Pick = C['type'] | typeof AGENT;

const options = computed<SelectOption<Pick>[]>(() => [{ value: AGENT, label: 'The agent’s default' }, ...props.choices.map((c) => ({ value: c.type, label: c.label }))]);
const picked = computed<Pick>(() => props.value?.type ?? AGENT);
const choice = computed(() => props.choices.find((c) => c.type === props.value?.type));
const draft = shallowRef<Json>(props.value === undefined ? {} : settingsValue(props.value));
const valid = ref(true);
watch(() => props.value, (value) => { draft.value = value === undefined ? {} : settingsValue(value); valid.value = true; });

const changed = computed(() => props.value !== undefined && JSON.stringify(draft.value) !== JSON.stringify(settingsValue(props.value)));
const about = computed(() => choice.value?.about ?? 'Follows what the agent fn says.');

function pick(next: Pick): void {
  if (next === picked.value) { return; }
  const variant = props.choices.find((c) => c.type === next);
  emit('change', variant === undefined ? null : props.defaults(variant.type));
}

function save(): void {
  const type = props.value?.type;
  if (type === undefined) { return; }
  const config = props.read(type, draft.value);
  if (config !== undefined) { emit('change', config); }
}
</script>

<template>
  <div class="mode-settings" :data-testid="testid">
    <UiSelect :model-value="picked" :options="options" :label="label" hide-label :disabled="busy" :data-testid="`${testid}-type`" @update:model-value="pick" />
    <p class="dim">{{ about }}</p>
    <template v-if="value !== undefined && choice?.settings">
      <GinValueView v-model="draft" :type="choice.settings" :label="label" @problems="valid = $event.length === 0" />
      <div v-if="changed" class="actions">
        <UiButton size="sm" variant="ghost" @click="draft = settingsValue(value)">Undo</UiButton>
        <UiButton size="sm" variant="primary" :disabled="!valid" :loading="busy" :data-testid="`${testid}-save`" @click="save">Save</UiButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mode-settings { display: grid; gap: var(--space-2); min-width: 0; }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>
