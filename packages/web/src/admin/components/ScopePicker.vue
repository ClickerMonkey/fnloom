<script setup lang="ts" generic="L extends string">
/**
 * Where a rule lives: the level, then what at that level (a group or person picked from the hub's actors; a system, fn
 * or model picked by searching; a chat or message id typed). The hub needs no target.
 */
import { computed } from 'vue';
import type { PickSource } from '@harness/core';
import HubPicker from '../../components/pickers/HubPicker.vue';
import { UiInput, UiSelect, onePicked, type SelectOption } from '../../ui/index.ts';
import type { ScopeDraft } from '../logic/forms.ts';
import type { ActorOption } from '../state/actors.ts';

const props = withDefaults(defineProps<{
  levels: readonly SelectOption<L>[];
  /** The actors to pick from at a level, when it is an actor level. */
  actorsAt: (level: L) => readonly ActorOption[] | undefined;
  error?: string;
}>(), { error: '' });
const model = defineModel<ScopeDraft<L>>({ required: true });

const PLACEHOLDER: Readonly<Record<string, string>> = { session: 'ses_…', turn: 'trn_…' };
/** The levels whose targets are picked by searching the hub. */
const PICKED: Readonly<Record<string, PickSource>> = { system: 'system', fn: 'fn', model: 'model' };
const picked = computed(() => PICKED[model.value.level]);
const actors = computed(() => props.actorsAt(model.value.level));
const actorChoices = computed<readonly SelectOption<string>[]>(() => [
  { value: '', label: 'Choose…' },
  ...(actors.value ?? []).map((a) => ({ value: a.id, label: a.name })),
]);
const levelLabel = computed(() => props.levels.find((l) => l.value === model.value.level)?.label ?? '');

function setLevel(level: L): void {
  model.value = { level, target: '' };
}

function setTarget(target: string): void {
  model.value = { ...model.value, target };
}
</script>

<template>
  <div class="scope-picker">
    <UiSelect :model-value="model.level" :options="levels" label="Applies to" @update:model-value="setLevel" />
    <template v-if="model.level !== 'hub'">
      <UiSelect v-if="actors !== undefined" :model-value="model.target" :options="actorChoices" :label="levelLabel" :error="error" @update:model-value="setTarget" />
      <HubPicker
        v-else-if="picked !== undefined" :key="model.level" :model-value="onePicked(model.target)" :source="picked" :max="1" :label="levelLabel" :placeholder="`Search ${levelLabel.toLowerCase()}s`"
        :error="error" @update:model-value="setTarget($event[0] ?? '')"
      />
      <UiInput v-else :model-value="model.target" :label="levelLabel" :placeholder="PLACEHOLDER[model.level] ?? ''" :error="error" @update:model-value="setTarget" />
    </template>
  </div>
</template>

<style scoped>
.scope-picker { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: var(--space-3); align-items: start; }
</style>
