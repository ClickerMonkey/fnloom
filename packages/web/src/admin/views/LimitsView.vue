<script setup lang="ts">
/**
 * Budgets and priorities, the tab in the URL: every budget with how much it has spent, every priority rule, and the
 * resolved view for a person (the person and chat are in the URL too, so a refresh works it out again).
 */
import { ActorId, SessionId, type BudgetRule, type LimitLevel, type PriorityRule } from '@harness/core';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { useParamChoice, useQueryText } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiEmpty, UiTabs, type TabItem } from '../../ui/index.ts';
import BudgetDialog from '../components/BudgetDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LoadState from '../components/LoadState.vue';
import PriorityDialog from '../components/PriorityDialog.vue';
import ResolvedView from '../components/ResolvedView.vue';
import RuleList from '../components/RuleList.vue';
import RuleRow from '../components/RuleRow.vue';
import SpendMeter from '../components/SpendMeter.vue';
import type { BudgetView } from '../contract.ts';
import { ACTOR_LEVELS, type BudgetBody, type PriorityBody } from '../logic/forms.ts';
import { ON_LIMIT_TEXT, PRIORITY_WORD, budgetAmount, scopeText } from '../logic/limits.ts';
import { LimitsTab } from '../sections.ts';
import type { ActorOption } from '../state/actors.ts';

const { admin, toasts } = useStores();
const limits = admin.limits;
const actors = admin.actors;
const tab = useParamChoice('tab', LimitsTab, 'budgets');
const userParam = useQueryText('user');
const sessionParam = useQueryText('session');

const budgetOpen = ref(false);
const priorityOpen = ref(false);
const editingBudget = shallowRef<BudgetView | undefined>(undefined);
const editingPriority = shallowRef<PriorityRule | undefined>(undefined);
const removing = shallowRef<{ kind: 'budget'; rule: BudgetRule } | { kind: 'priority'; rule: PriorityRule } | undefined>(undefined);
const removeOpen = computed({ get: () => removing.value !== undefined, set: (open) => { if (!open) { removing.value = undefined; } } });

const budgets = computed(() => limits.budgets.value.value ?? []);
const priorities = computed(() => limits.priorities.value.value ?? []);
const tabs = computed<readonly TabItem<LimitsTab>[]>(() => [
  { value: 'budgets', label: 'Budgets', count: budgets.value.length },
  { value: 'priorities', label: 'Priorities', count: priorities.value.length },
  { value: 'resolved', label: 'Resolved' },
]);
const people = computed(() => actors.options(['user']));

/** The actors to pick from at a level: groups and people come from the directory; other levels are typed. */
function actorsAt(level: LimitLevel): readonly ActorOption[] | undefined {
  return level === 'group' || level === 'user' ? actors.options([ACTOR_LEVELS[level]]) : undefined;
}

onMounted(() => { void limits.load(limits.budgets.value.value !== undefined); void actors.load(); });

// the resolved view follows the URL
watch([tab, userParam, sessionParam], ([current, user, session]) => {
  const who = ActorId.safeParse(user);
  if (current !== 'resolved' || !who.success) { return; }
  const where = SessionId.safeParse(session);
  void limits.resolve(who.data, where.success ? where.data : undefined);
}, { immediate: true });

function resolve(user: ActorId, session: SessionId | undefined): void {
  if (userParam.value === user && sessionParam.value === (session ?? '')) { void limits.resolve(user, session); return; }
  userParam.value = user;
  sessionParam.value = session ?? '';
}

function editBudget(budget?: BudgetView): void { editingBudget.value = budget; budgetOpen.value = true; }
function editPriority(rule?: PriorityRule): void { editingPriority.value = rule; priorityOpen.value = true; }

async function saveBudget(body: BudgetBody): Promise<void> {
  if ((await limits.saveBudget(body)).ok) { budgetOpen.value = false; toasts.ok('Budget saved'); }
}

async function savePriority(body: PriorityBody): Promise<void> {
  if ((await limits.savePriority(body)).ok) { priorityOpen.value = false; toasts.ok('Priority rule saved'); }
}

async function confirmRemove(): Promise<void> {
  const target = removing.value;
  if (target === undefined) { return; }
  const ok = target.kind === 'budget' ? await limits.removeBudget(target.rule.id) : await limits.removePriority(target.rule.id);
  removing.value = undefined;
  if (ok) { toasts.ok('Removed'); } else { toasts.error(limits.remove.problem.value); }
}
</script>

<template>
  <AppPage title="Limits" description="How much may be spent, and how urgently work runs, at each level.">
    <UiTabs v-model="tab" :tabs="tabs" label="Limits" />
    <LoadState
      v-if="tab !== 'resolved'" :loading="limits.budgets.loading.value" :problem="limits.budgets.problem.value || limits.priorities.problem.value"
      :ready="limits.budgets.value.value !== undefined" :empty="false" @retry="limits.load()"
    >
      <template v-if="tab === 'budgets'">
        <RuleList title="Budgets" description="A turn's budget shrinks as the budgets above it run low." add="New budget" testid="budgets" @add="editBudget()">
          <RuleRow
            v-for="budget in budgets" :key="budget.id" icon="coins" :title="scopeText(budget.target, actors.nameOf)" :detail="budgetAmount(budget)"
            label="budget" @edit="editBudget(budget)" @remove="removing = { kind: 'budget', rule: budget }"
          >
            <template #badges>
              <UiBadge>{{ ON_LIMIT_TEXT[budget.onLimit] }}</UiBadge>
              <UiBadge v-if="budget.share">{{ budget.share === 'pooled' ? 'Shared pot' : 'Each member' }}</UiBadge>
            </template>
            <template v-if="budget.period !== 'per-turn'" #measure><SpendMeter :spent="budget.spent" :max="budget.maxCost" /></template>
          </RuleRow>
        </RuleList>
        <UiEmpty v-if="budgets.length === 0" icon="coins" title="No budgets" body="Without one, nothing limits spending." />
      </template>
      <template v-else>
        <RuleList title="Priority rules" description="Interactive chat runs before background work." add="New rule" testid="priorities" @add="editPriority()">
          <RuleRow
            v-for="rule in priorities" :key="rule.id" icon="arrow-up" :title="scopeText(rule.target, actors.nameOf)" label="priority rule"
            :detail="[rule.default ? `Default ${PRIORITY_WORD[rule.default].toLowerCase()}` : '', rule.max ? `at most ${PRIORITY_WORD[rule.max].toLowerCase()}` : ''].filter(Boolean).join(', ')"
            @edit="editPriority(rule)" @remove="removing = { kind: 'priority', rule }"
          />
        </RuleList>
        <UiEmpty v-if="priorities.length === 0" icon="arrow-up" title="No priority rules" body="Every turn runs at the hub's default." />
      </template>
    </LoadState>
    <ResolvedView
      v-else :people="people" :resolved="limits.resolved.value.value" :loading="limits.resolved.loading.value" :name-of="actors.nameOf"
      :user="userParam" :session="sessionParam" @resolve="resolve"
    />
    <p v-if="tab === 'resolved' && limits.resolved.problem.value !== ''" class="problem" role="alert">{{ limits.resolved.problem.value }}</p>

    <BudgetDialog v-model:open="budgetOpen" :budget="editingBudget" :actors-at="actorsAt" :busy="limits.save.busy.value" :problem="limits.save.problem.value" @save="saveBudget" />
    <PriorityDialog v-model:open="priorityOpen" :rule="editingPriority" :actors-at="actorsAt" :busy="limits.save.busy.value" :problem="limits.save.problem.value" @save="savePriority" />
    <ConfirmDialog
      v-model:open="removeOpen" :title="removing?.kind === 'budget' ? 'Remove this budget?' : 'Remove this priority rule?'"
      body="It stops applying to new turns at once." confirm="Remove" :busy="limits.remove.busy.value" @confirm="confirmRemove"
    />
  </AppPage>
</template>

<style scoped>
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
