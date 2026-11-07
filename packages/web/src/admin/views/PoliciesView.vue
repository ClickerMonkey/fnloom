<script setup lang="ts">
/**
 * Policies, in the order the hub weighs them: each as a sentence (who, which fns, what it decides), with what
 * applies when none match. Making, changing and removing policies.
 */
import type { Policy } from '@harness/core';
import { computed, onMounted, ref, shallowRef } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiBanner, UiButton } from '../../ui/index.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LoadState from '../components/LoadState.vue';
import PolicyDialog from '../components/PolicyDialog.vue';
import RuleList from '../components/RuleList.vue';
import RuleRow from '../components/RuleRow.vue';
import type { PolicyBody } from '../logic/forms.ts';
import { decisionText, subjectText, targetText } from '../logic/policies.ts';

const { admin, toasts } = useStores();
const policies = admin.policies;
const actors = admin.actors;
const open = ref(false);
const editing = shallowRef<Policy | undefined>(undefined);
const removing = shallowRef<Policy | undefined>(undefined);
const removeOpen = computed({ get: () => removing.value !== undefined, set: (isOpen) => { if (!isOpen) { removing.value = undefined; } } });
const people = computed(() => actors.options(['user', 'agent']));
const groups = computed(() => actors.options(['group']));

onMounted(() => { void policies.load(policies.list.value.value !== undefined); void actors.load(); });

function edit(policy?: Policy): void { editing.value = policy; open.value = true; }

async function save(body: PolicyBody): Promise<void> {
  if ((await policies.savePolicy(body)).ok) { open.value = false; toasts.ok('Policy saved'); }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === undefined) { return; }
  const ok = await policies.removePolicy(target.id);
  removing.value = undefined;
  if (ok) { toasts.ok('Policy removed'); } else { toasts.error(policies.remove.problem.value); }
}
</script>

<template>
  <AppPage title="Policies" description="Who may run which fns, and who is asked first.">
    <template #actions><UiButton variant="primary" icon="plus" data-testid="new-policy" @click="edit()">New policy</UiButton></template>
    <UiBanner tone="neutral" icon="info">With no matching policy, fns tagged <code>read</code> run, and anything else asks the person who sent the message.</UiBanner>
    <LoadState
      :loading="policies.list.loading.value" :problem="policies.list.problem.value" :ready="policies.list.value.value !== undefined"
      :empty="policies.sorted.value.length === 0" empty-icon="shield" empty-title="No policies yet" empty-body="The defaults above apply to every fn." @retry="policies.load()"
    >
      <RuleList title="In the order they are weighed" testid="policies">
        <RuleRow
          v-for="policy in policies.sorted.value" :key="policy.id" icon="shield" :title="policy.description" label="policy"
          :detail="`${subjectText(policy.subject, actors.nameOf)} · ${targetText(policy.target)} · ${decisionText(policy.decision, actors.nameOf).detail}`"
          @edit="edit(policy)" @remove="removing = policy"
        >
          <template #badges>
            <UiBadge :tone="decisionText(policy.decision, actors.nameOf).tone">{{ decisionText(policy.decision, actors.nameOf).word }}</UiBadge>
            <UiBadge>Rank {{ policy.priority }}</UiBadge>
          </template>
        </RuleRow>
      </RuleList>
    </LoadState>
    <PolicyDialog v-model:open="open" :policy="editing" :people="people" :groups="groups" :busy="policies.save.busy.value" :problem="policies.save.problem.value" @save="save" />
    <ConfirmDialog v-model:open="removeOpen" title="Remove this policy?" :body="removing?.description ?? ''" confirm="Remove" :busy="policies.remove.busy.value" @confirm="confirmRemove" />
  </AppPage>
</template>
