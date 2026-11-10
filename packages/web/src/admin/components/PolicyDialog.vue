<script setup lang="ts">
/**
 * Making or changing a policy: who it covers, which fns (by name or glob, system, kind and tags; all given must
 * match), what it decides (allow, deny with a reason, or ask someone), and how it ranks against others.
 */
import { ActorKind, type Policy } from '@harness/core';
import { computed, ref, watch } from 'vue';
import HubPicker from '../../components/pickers/HubPicker.vue';
import { UiBanner, UiButton, UiChipInput, UiDialog, UiInput, UiSegmented, UiSelect, UiTextarea, onePicked, optionsOf, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { policyBody, policyDraft, type ApproverKind, type PolicyBody, type PolicyDraft, type SubjectKind } from '../logic/forms.ts';
import { ACTOR_KIND_WORDS } from '../logic/policies.ts';
import type { ActorOption } from '../state/actors.ts';

const props = withDefaults(defineProps<{
  policy?: Policy | undefined;
  people: readonly ActorOption[];
  groups: readonly ActorOption[];
  busy?: boolean;
  problem?: string;
}>(), { policy: undefined, busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [body: PolicyBody] }>();

const subjects = optionsOf({ everyone: 'Everyone', actor: 'One actor', group: 'A group', kind: 'A kind of actor' } satisfies Record<SubjectKind, string>);
const kinds = ActorKind.options.map((k): SelectOption<string> => ({ value: k, label: ACTOR_KIND_WORDS[k].label }));
const effects: readonly SegmentOption<PolicyDraft['effect']>[] = optionsOf({ allow: 'Allow', ask: 'Ask', deny: 'Deny' } satisfies Record<PolicyDraft['effect'], string>);
const approvers = optionsOf({ 'turn-user': "The message's sender", actor: 'A person', group: 'A group', admins: 'Any admin', judge: 'A judge fn', hub: 'The hub' } satisfies Record<ApproverKind, string>);
const pick = (options: readonly ActorOption[]): readonly SelectOption<string>[] => [{ value: '', label: 'Choose…' }, ...options.map((o) => ({ value: o.id, label: o.name }))];

/** Words as typed taken as a value (a glob, a kind, a tag). */
const asTyped = (text: string): string | undefined => (text === '' ? undefined : text);
const draft = ref<PolicyDraft>(policyDraft());
const tried = ref(false);
const checked = computed(() => policyBody(draft.value));
const errorOf = (field: keyof PolicyBody): string => (tried.value && !checked.value.ok ? checked.value.problems[field] ?? '' : '');
const subjectChoices = computed(() => (draft.value.subject === 'group' ? pick(props.groups) : draft.value.subject === 'kind' ? kinds : pick([...props.people, ...props.groups])));

watch(open, (isOpen) => { if (isOpen) { draft.value = policyDraft(props.policy); tried.value = false; } });
watch(() => draft.value.subject, (now, was) => { if (now !== was) { draft.value.subjectValue = ''; } });
watch(() => draft.value.approver, (now, was) => { if (now !== was) { draft.value.approverValue = ''; } });

function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog v-model:open="open" :title="policy ? 'Edit policy' : 'New policy'" description="Deny beats ask beats allow; a more specific match beats a broader one." width="600px">
    <form class="form" novalidate data-testid="policy-form" @submit.prevent="save">
      <UiTextarea v-model="draft.description" label="What it is for" placeholder="Writing files asks first" :rows="2" required :error="errorOf('description')" />

      <fieldset class="group">
        <legend>Who</legend>
        <div class="grid">
          <UiSelect v-model="draft.subject" :options="subjects" label="Covers" />
          <UiSelect v-if="draft.subject !== 'everyone'" v-model="draft.subjectValue" :options="subjectChoices" :label="draft.subject === 'kind' ? 'Kind' : 'Which'" :error="errorOf('subject')" />
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>Which fns</legend>
        <div class="grid">
          <HubPicker :model-value="onePicked(draft.fn)" source="fn" :max="1" :custom="asTyped" label="Name or pattern" placeholder="fs/* or a fn" @update:model-value="draft.fn = $event[0] ?? ''" />
          <HubPicker :model-value="onePicked(draft.system)" source="system" :max="1" label="System" placeholder="Any" :error="errorOf('target')" @update:model-value="draft.system = $event[0] ?? ''" />
          <HubPicker :model-value="onePicked(draft.kind)" source="kind" :max="1" :custom="asTyped" label="Kind" placeholder="native, or hub/llm" @update:model-value="draft.kind = $event[0] ?? ''" />
          <UiChipInput v-model="draft.tags" label="Tags" placeholder="write" hint="All must match." :read="asTyped" />
        </div>
      </fieldset>

      <fieldset class="group">
        <legend>Decision</legend>
        <UiSegmented v-model="draft.effect" :options="effects" label="Decision" />
        <UiInput v-if="draft.effect === 'deny'" v-model="draft.reason" label="Why" placeholder="Shown to whoever it stops" :error="errorOf('decision')" />
        <div v-if="draft.effect === 'ask'" class="grid">
          <UiSelect v-model="draft.approver" :options="approvers" label="Who answers" />
          <UiSelect v-if="draft.approver === 'actor'" v-model="draft.approverValue" :options="pick(people)" label="Person" :error="errorOf('decision')" />
          <UiSelect v-if="draft.approver === 'group'" v-model="draft.approverValue" :options="pick(groups)" label="Group" :error="errorOf('decision')" />
          <UiInput v-if="draft.approver === 'group'" v-model="draft.quorum" type="number" label="Answers needed" placeholder="1" />
          <HubPicker
            v-if="draft.approver === 'judge'" :model-value="onePicked(draft.approverValue)" source="fn" :max="1" label="Judge fn" placeholder="Search fns" :error="errorOf('decision')"
            @update:model-value="draft.approverValue = $event[0] ?? ''"
          />
        </div>
      </fieldset>

      <UiInput v-model="draft.priority" type="number" label="Rank" hint="Higher ranks are weighed first." :error="errorOf('priority')" />
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="policy-save" @click="save">Save policy</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); }
.group { display: grid; gap: var(--space-3); margin: 0; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); min-width: 0; }
legend { padding: 0 var(--space-1); font-size: var(--text-sm); font-weight: var(--weight-strong); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); align-items: start; gap: var(--space-3); }
</style>
