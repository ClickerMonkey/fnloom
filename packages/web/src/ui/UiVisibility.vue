<script setup lang="ts">
/**
 * Who may see and use a thing: Only me, Me and chosen people (with a picker of people and groups), or Everyone. The
 * page shows it only on a hub with more than one person. `readonly` shows the choice without changing it (someone
 * else's thing).
 */
import { ActorId, VISIBILITY_LABELS, type ShareRule, type Visibility } from '@harness/core';
import { computed } from 'vue';
import UiPicker from './UiPicker.vue';
import UiSegmented from './UiSegmented.vue';
import type { IconName } from './icons.ts';
import type { PickerSource } from './picker.ts';
import type { SegmentOption } from './types.ts';

const props = withDefaults(defineProps<{
  /** People and groups to share with. */
  people: PickerSource;
  label?: string;
  readonly?: boolean;
}>(), { label: 'Who can use it', readonly: false });
const model = defineModel<ShareRule>({ required: true });

const ICONS = { private: 'user', shared: 'users', public: 'globe' } as const satisfies Record<Visibility, IconName>;
const OPTIONS: readonly SegmentOption<Visibility>[] = (['private', 'shared', 'public'] as const).map((value) => ({ value, label: VISIBILITY_LABELS[value], icon: ICONS[value] }));

const visibility = computed({
  get: () => model.value.visibility,
  set: (next: Visibility) => { if (!props.readonly) { model.value = { ...model.value, visibility: next }; } },
});
const withWhom = computed({
  get: (): readonly string[] => model.value.with,
  set: (next: readonly string[]) => {
    model.value = { ...model.value, with: next.flatMap((value) => { const read = ActorId.safeParse(value); return read.success ? [read.data] : []; }) };
  },
});
</script>

<template>
  <div class="ui-visibility" data-testid="visibility">
    <div class="row">
      <span class="label">{{ label }}</span>
      <UiSegmented v-model="visibility" :options="OPTIONS" :label="label" :class="{ locked: readonly }" data-testid="visibility-choice" />
    </div>
    <UiPicker
      v-if="visibility === 'shared'" v-model="withWhom" :source="people" label="Shared with" placeholder="Add people or groups" :code="false" :disabled="readonly"
      testid="visibility-people"
    />
  </div>
</template>

<style scoped>
.ui-visibility { display: grid; gap: var(--space-2); min-width: 0; }
.row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.locked { pointer-events: none; opacity: 0.7; }
</style>
