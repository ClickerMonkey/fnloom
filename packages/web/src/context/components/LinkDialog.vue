<script setup lang="ts">
/**
 * Drawing a link from a context item: what it points at (another context item, a fn, a type, or a resource with an
 * optional section), how they relate (each relation with a line on what it means), and how strongly, 0 to 1. The draft
 * is checked as it is typed (`linkRequest`); the problem shows under the target, and Save sends the draft.
 */
import { DECLARABLE_RELATIONS, HUB_RESOURCE_ROOT, type DeclarableRelation, type LinkTargetKind, type QualifiedName } from '@harness/core';
import { computed, ref, watch } from 'vue';
import HubPicker from '../../components/pickers/HubPicker.vue';
import { UiBanner, UiButton, UiDialog, UiField, UiInput, UiSegmented, UiSelect, onePicked, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { emptyLinkDraft, linkRequest, RELATION_WORDS, TARGET_WORDS, type LinkDraft } from '../logic/context.ts';

const props = withDefaults(defineProps<{ from: QualifiedName; busy?: boolean; problem?: string }>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [draft: LinkDraft] }>();

const KINDS: readonly SegmentOption<LinkTargetKind>[] = (['context', 'fn', 'type', 'resource'] as const).map((kind) => ({ value: kind, label: TARGET_WORDS[kind].label, icon: TARGET_WORDS[kind].icon }));
const RELATIONS: readonly SelectOption<DeclarableRelation>[] = DECLARABLE_RELATIONS.map((relation) => ({ value: relation, label: RELATION_WORDS[relation].label }));
const PLACEHOLDER = { context: 'Search context', fn: 'Search fns', type: 'Search types', resource: `Search, or paste ${HUB_RESOURCE_ROOT}…` } as const satisfies Record<LinkTargetKind, string>;
/** A resource address pasted whole is taken as typed. */
const asAddress = (text: string): string | undefined => (text.includes('://') ? text : undefined);

const kind = ref<LinkTargetKind>('context');
const target = ref('');
const section = ref('');
const relation = ref<DeclarableRelation>('related');
const weight = ref(0.5);
/** Whether Save was pressed, so problems show only once there is something to say. */
const tried = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) { return; }
  const fresh = emptyLinkDraft();
  kind.value = fresh.kind; target.value = fresh.target; section.value = fresh.section; relation.value = fresh.relation; weight.value = fresh.weight;
  tried.value = false;
}, { immediate: true });

const draft = computed((): LinkDraft => ({ kind: kind.value, target: target.value, section: section.value, relation: relation.value, weight: weight.value }));
const checked = computed(() => linkRequest(draft.value, props.from));
const targetError = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', draft.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Add a link" :description="`From ${from}. The graph contextor follows links when it picks what a message gets.`" width="520px">
    <form class="form" data-testid="link-form" @submit.prevent="save">
      <div class="field">
        <span class="label">Links to</span>
        <UiSegmented v-model="kind" :options="KINDS" label="Links to" data-testid="link-kind" />
      </div>
      <HubPicker
        :key="kind" :model-value="onePicked(target)" :source="kind" :max="1" :custom="kind === 'resource' ? asAddress : undefined" :label="kind === 'resource' ? 'Resource' : TARGET_WORDS[kind].label"
        :placeholder="PLACEHOLDER[kind]" :error="targetError" testid="link-target" @update:model-value="target = $event[0] ?? ''"
      />
      <UiInput v-if="kind === 'resource'" v-model="section" label="Section" hint="Optional: a heading or symbol of the resource." placeholder="Usage" />
      <UiSelect v-model="relation" :options="RELATIONS" label="How they relate" :hint="RELATION_WORDS[relation].about" data-testid="link-relation" />
      <UiField v-slot="{ id }" label="Weight" :hint="`${weight.toFixed(2)}: how strongly a match on one end lifts the other.`">
        <input :id="id" v-model.number="weight" class="slider" type="range" min="0" max="1" step="0.05" data-testid="link-weight">
      </UiField>
      <UiBanner v-if="problem !== ''" tone="danger" icon="warning">{{ problem }}</UiBanner>
      <button type="submit" hidden />
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" icon="link" :loading="busy" data-testid="link-save" @click="save">Add link</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.field { display: grid; gap: var(--space-2); }
.label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.slider { width: 100%; accent-color: var(--accent); }
</style>
