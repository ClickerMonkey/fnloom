<script setup lang="ts">
/**
 * A system's own config component (build 7), loaded from its client build: it gets the config, its gin type, gin's
 * check of a value and the system's client, and emits `change` with a new value. Save sends that value; the hub checks
 * it again with the gin type. While the build loads a skeleton shows; a build that fails to load says so, and the gin
 * form (when shown beside it) still works.
 */
import type { GinTypeDef, Json } from '@harness/core';
import { computed, inject, shallowRef, watch, type Component } from 'vue';
import { GIN_TYPES, LOCAL_TYPES } from '../../gin/types.ts';
import { UiBanner, UiButton, UiCard, UiSkeleton } from '../../ui/index.ts';
import type { ConfigComponentRef, ConfigComponents, ConfigViewProps } from '../state/config-component.ts';

const props = withDefaults(defineProps<{
  target: ConfigComponentRef;
  loader: ConfigComponents;
  type: GinTypeDef;
  value: Json | undefined;
  busy?: boolean;
}>(), { busy: false });
const emit = defineEmits<{ save: [value: Json] }>();

const types = inject(GIN_TYPES, LOCAL_TYPES);
const component = shallowRef<Component | undefined>(undefined);
const problem = shallowRef('');
const draft = shallowRef<Json | undefined>(props.value);
watch(() => props.value, (value) => { draft.value = value; });

watch(() => props.target, async (target) => {
  component.value = undefined;
  problem.value = '';
  try {
    component.value = await props.loader.load(target);
  } catch (error) {
    problem.value = error instanceof Error ? error.message : `Couldn't load ${target.system}'s config component.`;
  }
}, { immediate: true });

/** gin's problems with a value, one sentence each. */
function validate(value: Json): readonly string[] {
  const check = types.checker(props.type);
  if (check === undefined) { return []; }
  return check(value).map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.map(String).join('.')}: ${issue.message}`));
}

const viewProps = computed<ConfigViewProps>(() => ({ config: draft.value, type: props.type, validate, client: props.loader.client(props.target.system) }));
const problems = computed(() => (draft.value === undefined ? [] : validate(draft.value)));
const changed = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.value));
</script>

<template>
  <UiCard :title="`${target.system}’s own settings`" subtitle="Drawn by the system itself; the hub still checks the config before saving." data-testid="config-custom">
    <div class="body">
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
      <UiSkeleton v-else-if="component === undefined" :lines="3" />
      <component :is="component" v-else v-bind="viewProps" @change="(value: Json) => (draft = value)" />
      <ul v-if="changed && problems.length > 0" class="problems" data-testid="config-custom-problems">
        <li v-for="line in problems" :key="line">{{ line }}</li>
      </ul>
      <div v-if="component !== undefined" class="actions">
        <UiButton variant="primary" :disabled="!changed || draft === undefined || problems.length > 0" :loading="busy" data-testid="config-custom-save" @click="draft !== undefined && emit('save', draft)">Save config</UiButton>
      </div>
    </div>
  </UiCard>
</template>

<style scoped>
.body { display: grid; gap: var(--space-3); }
.problems { margin: 0; padding-left: var(--space-5); color: var(--danger); font-size: var(--text-sm); }
.actions { display: flex; justify-content: flex-end; }
</style>
