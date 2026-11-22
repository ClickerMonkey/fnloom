<script setup lang="ts">
/**
 * One item kind's search setting (fns' or context's), one choice: as ranked (nobody filters), a decision model (its
 * own or the Decisions role's; one yes/no question per hit, kept at the role's threshold), or an LLM (asked which hits
 * to keep, with reasons). It applies wherever the search is asked: the model's `hub/fns_search` and the web's search.
 * A judge's action returns the kept hits, or also loads the best of them when the chat model searches.
 */
import { CHOOSER_ACTIONS, SEARCH_JUDGES, type ChooserAction, type ModelInfo, type SearchDecision, type SearchDecisionView, type SearchItemKind, type SearchJudge } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ModelPicker from '../../chat/components/ModelPicker.vue';
import type { ModelPick } from '../../chat/logic/session.ts';
import { UiBanner, UiButton, UiDialog, UiField, UiSegmented, type SegmentOption } from '../../ui/index.ts';
import { chooserModels, SEARCH_ACTION_WORDS, SEARCH_ITEM_WORDS, SEARCH_JUDGE_WORDS, searchDecisionOf, searchDraft, type SearchDraft } from '../logic/suggestions.ts';

const props = withDefaults(defineProps<{
  item: SearchItemKind;
  view: SearchDecisionView | undefined;
  models: readonly ModelInfo[];
  busy?: boolean;
  problem?: string;
}>(), { busy: false, problem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [value: SearchDecision] }>();

const draft = ref<SearchDraft>(searchDraft(undefined));
const tried = ref(false);
watch(open, (isOpen) => { if (isOpen) { draft.value = searchDraft(props.view); tried.value = false; } }, { immediate: true });
const set = <K extends keyof SearchDraft>(key: K, value: SearchDraft[K]): void => { draft.value = { ...draft.value, [key]: value }; };

const JUDGES: readonly SegmentOption<SearchJudge>[] = SEARCH_JUDGES.map((value) => ({ value, label: SEARCH_JUDGE_WORDS[value].label, icon: SEARCH_JUDGE_WORDS[value].icon }));
const by = computed({ get: () => draft.value.by, set: (value: SearchJudge) => { set('by', value); } });
const ACTIONS: readonly SegmentOption<ChooserAction>[] = CHOOSER_ACTIONS.map((value) => ({ value, label: SEARCH_ACTION_WORDS[value].label, icon: SEARCH_ACTION_WORDS[value].icon }));
const action = computed({ get: () => draft.value.action, set: (value: ChooserAction) => { set('action', value); } });
const checked = computed(() => searchDecisionOf(draft.value));
const modelError = computed(() => (tried.value && !checked.value.ok ? checked.value.problem : ''));
/** The chosen model of the judge on show: the decision model's or the LLM's. */
const chosenId = computed(() => (draft.value.by === 'llm' ? draft.value.llm : draft.value.decision));
const pickable = computed(() => chooserModels(draft.value.by, props.models));
const picked = computed<ModelPick>(() => (chosenId.value === '' ? 'default' : `model:${chosenId.value}`));
const chosenText = computed(() => {
  if (chosenId.value !== '') { return chosenId.value; }
  return draft.value.by === 'decision' ? 'The Decisions role’s model' : 'None yet';
});
function pick(choice: ModelPick): void {
  if (choice === 'default') { return; }
  set(draft.value.by === 'llm' ? 'llm' : 'decision', choice.slice('model:'.length));
}
function save(): void {
  tried.value = true;
  if (checked.value.ok) { emit('save', checked.value.value); }
}
</script>

<template>
  <UiDialog
    v-model:open="open" :title="SEARCH_ITEM_WORDS[item].title" :description="`Who filters ${SEARCH_ITEM_WORDS[item].hits} hits of a search before they are returned, wherever the search is asked.`"
    width="560px"
  >
    <form class="form" novalidate data-testid="search-decision-form" :data-item="item" :data-by="draft.by" @submit.prevent="save">
      <UiSegmented v-model="by" :options="JUDGES" label="Who filters" data-testid="search-decision-by" />
      <p class="dim" data-testid="search-decision-about">{{ SEARCH_JUDGE_WORDS[draft.by].about }}</p>
      <UiField v-if="draft.by !== 'none'" :label="draft.by === 'llm' ? 'LLM' : 'Decision model'" :error="modelError" :required="draft.by === 'llm'">
        <div class="model" data-testid="search-decision-model">
          <div class="chosen-row">
            <p class="chosen"><span class="dim">Chosen:</span> {{ chosenText }}</p>
            <UiButton v-if="draft.by === 'decision' && draft.decision !== ''" size="sm" variant="ghost" icon="undo" data-testid="search-decision-role-model" @click="set('decision', '')">
              Use the Decisions role’s
            </UiButton>
          </div>
          <ModelPicker :models="pickable" :current="picked" :own-choice="false" :limit="100" list-height="min(240px, 32vh)" @pick="pick" />
          <p v-if="draft.by === 'decision' && pickable.length === 0" class="dim">No provider offers a decision model yet: add one (an Ollama System One model, or a system’s provider).</p>
        </div>
      </UiField>
      <template v-if="draft.by !== 'none'">
        <UiSegmented v-model="action" :options="ACTIONS" label="What it does" data-testid="search-decision-action" />
        <p class="dim" data-testid="search-decision-action-about">{{ SEARCH_ACTION_WORDS[draft.action].about }}</p>
      </template>
      <p v-if="draft.by !== 'none'" class="dim">Each check is a model call charged to the run that searched. If the model fails, every hit is kept and the search says so.</p>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="search-decision-save" @click="save">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); }
.model { display: grid; gap: var(--space-2); min-width: 0; }
.chosen-row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; justify-content: space-between; }
.chosen { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
