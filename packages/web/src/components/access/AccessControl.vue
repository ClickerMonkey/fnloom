<script setup lang="ts">
/**
 * A "Sharing" card: who may see and use one thing (a system, a fn, a context item, a resource root, a connection),
 * shown only on a hub with more than one person and saved as it is changed. Its owner or an admin can change it; anyone else sees it.
 * Someone else's thing (an admin looking at it) names its owner: "Only Ana", "Ana and chosen people". `fixed` locks it to
 * only its owner, with that reason (a memory written for its author alone). Mounted outside the app (no stores) it shows nothing.
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
  /** The tighter card padding, to match compact neighbour cards. */
  compact?: boolean;
  /** Why it is only its owner's and cannot change; shown locked to "only" when set. */
  fixed?: string | undefined;
}>(), { label: 'Who can use it', title: 'Sharing', compact: false, fixed: undefined });

const stores = useStoresIfAny();
const access = stores?.chat.access;
const people = usePickerSources().people();
const view = shallowRef<Loaded<AccessView> | undefined>(undefined);
const shown = computed(() => access?.multiUser.value === true);

onMounted(() => { void access?.load(); });
watch([() => accessKey(props.target), shown], ([, multi]) => {
  view.value = multi && access !== undefined ? access.view(props.target) : undefined;
}, { immediate: true });

const owner = computed(() => view.value?.value.value?.sharing.owner);
/** The owner's name when the viewer is someone else; blank when it is the viewer's own. */
const ownerName = shallowRef('');
watch(owner, async (id) => {
  ownerName.value = '';
  if (id === undefined || id === stores?.session.user.value?.id) { return; }
  const [found] = await people.label([id]).catch(() => []);
  if (owner.value === id) { ownerName.value = found === undefined || found.missing === true ? 'its owner' : found.label; }
}, { immediate: true });

const rule = computed({
  get: (): ShareRule | undefined => {
    if (props.fixed !== undefined) { return { visibility: 'private', with: [] }; }
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
  <UiCard v-if="shown && view !== undefined" :title="title" :compact="compact" data-testid="access-control">
    <p v-if="view.problem.value !== ''" class="problem">{{ view.problem.value }}</p>
    <UiVisibility v-else-if="rule !== undefined" v-model="rule" :people="people" :label="label" :owner="ownerName" :readonly="fixed !== undefined || view.value.value?.editable === false" />
    <p v-if="fixed !== undefined" class="note" data-testid="access-fixed">{{ fixed }}</p>
    <p v-if="access?.saving.problem.value" class="problem" role="alert">{{ access.saving.problem.value }}</p>
  </UiCard>
</template>

<style scoped>
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.note { margin: var(--space-2) 0 0; color: var(--text-faint); font-size: var(--text-xs); }
</style>
