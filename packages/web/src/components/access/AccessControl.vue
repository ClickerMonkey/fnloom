<script setup lang="ts">
/**
 * A "Sharing" card: who may see and use one thing (a system, a fn, a context item, a resource root, a connection),
 * shown only on a hub with more than one person and saved as it is changed. Its owner or an admin can change it; anyone else sees it.
 * Mounted outside the app (no stores) it shows nothing.
 */
import { accessKey, type AccessTarget, type AccessView, type ShareRule } from '@harness/core';
import { computed, onMounted, shallowRef, watch } from 'vue';
import type { Loaded } from '../../state/loaded.ts';
import { useStoresIfAny } from '../../state/stores.ts';
import UiCard from '../../ui/UiCard.vue';
import UiVisibility from '../../ui/UiVisibility.vue';
import { usePickerSources } from '../pickers/sources.ts';

const props = withDefaults(defineProps<{
  target: AccessTarget;
  label?: string;
  title?: string;
}>(), { label: 'Who can use it', title: 'Sharing' });

const access = useStoresIfAny()?.chat.access;
const people = usePickerSources().people();
const view = shallowRef<Loaded<AccessView> | undefined>(undefined);
const shown = computed(() => access?.multiUser.value === true);

onMounted(() => { void access?.load(); });
watch([() => accessKey(props.target), shown], ([, multi]) => {
  view.value = multi && access !== undefined ? access.view(props.target) : undefined;
}, { immediate: true });

const rule = computed({
  get: (): ShareRule | undefined => {
    const sharing = view.value?.value.value?.sharing;
    return sharing === undefined ? undefined : { visibility: sharing.visibility, with: sharing.with };
  },
  set: (next: ShareRule | undefined) => { if (next !== undefined) { void save(next); } },
});

async function save(next: ShareRule): Promise<void> {
  if (access === undefined || view.value === undefined) { return; }
  const saved = await access.set(props.target, next);
  if (saved.ok) { view.value.set(saved.value); }
}
</script>

<template>
  <UiCard v-if="shown && view !== undefined" :title="title" compact data-testid="access-control">
    <p v-if="view.problem.value !== ''" class="problem">{{ view.problem.value }}</p>
    <UiVisibility v-else-if="rule !== undefined" v-model="rule" :people="people" :label="label" :readonly="view.value.value?.editable === false" />
    <p v-if="access?.saving.problem.value" class="problem" role="alert">{{ access.saving.problem.value }}</p>
  </UiCard>
</template>

<style scoped>
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
