<script setup lang="ts">
/**
 * The suggestions setting, one choice: no model (the score threshold decides), a decision model (its own or the
 * Decisions role's; one yes/no question per candidate, picked at the role's threshold), or an LLM (asked for its picks
 * with reasons). A model chooser also sets how many of the person's recent messages it reads, how many candidates above
 * which score it sees, and the most it picks. "Try it" shows what would be suggested for a message in a session now:
 * what is used and what is left out, with each reason.
 */
import { SessionId, type ModelInfo, type SessionSummary, type SuggestDecision, type SuggestDecisionView, type SuggestionChooser, type SuggestionRecord, SUGGESTION_CHOOSERS } from '@harness/core';
import { computed, ref, watch } from 'vue';
import FnPill from '../../fns/components/FnPill.vue';
import ModelPicker from '../../chat/components/ModelPicker.vue';
import type { ModelPick } from '../../chat/logic/session.ts';
import { UiBanner, UiButton, UiDialog, UiField, UiInput, UiSegmented, UiSelect, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { CHOOSER_WORDS, chooserModels, decisionDraft, decisionOf, previewParts, type DecisionDraft } from '../logic/suggestions.ts';

const props = withDefaults(defineProps<{
  view: SuggestDecisionView | undefined;
  models: readonly ModelInfo[];
  sessions: readonly SessionSummary[];
  busy?: boolean;
  problem?: string;
  preview?: SuggestionRecord | undefined;
  previewing?: boolean;
  previewProblem?: string;
}>(), { busy: false, problem: '', preview: undefined, previewing: false, previewProblem: '' });
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ save: [value: SuggestDecision]; try: [session: SessionId, text: string] }>();

const draft = ref<DecisionDraft>(decisionDraft(undefined));
const tried = ref(false);
watch(open, (isOpen) => { if (isOpen) { draft.value = decisionDraft(props.view); tried.value = false; } }, { immediate: true });
const set = <K extends keyof DecisionDraft>(key: K, value: DecisionDraft[K]): void => { draft.value = { ...draft.value, [key]: value }; };

const CHOOSERS: readonly SegmentOption<SuggestionChooser>[] = SUGGESTION_CHOOSERS.map((value) => ({ value, label: CHOOSER_WORDS[value].label, icon: CHOOSER_WORDS[value].icon }));
const by = computed({ get: () => draft.value.by, set: (value: SuggestionChooser) => { set('by', value); } });
const usesModel = computed(() => draft.value.by !== 'none');

const checked = computed(() => decisionOf(draft.value));
const modelError = computed(() => (tried.value && !checked.value.ok && checked.value.at === 'model' ? checked.value.problem : ''));
const numbersError = computed(() => (tried.value && !checked.value.ok && checked.value.at === 'numbers' ? checked.value.problem : ''));
/** The chosen model of the chooser on show: the decision model's or the LLM's. */
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

/** The chosen session's id; '' for none yet. */
const session = ref('');
const text = ref('');
watch(() => props.sessions, (list) => { if (session.value === '' && list[0] !== undefined) { session.value = list[0].id; } }, { immediate: true });
const sessionOptions = computed<SelectOption<string>[]>(() => [{ value: '', label: 'Pick a session' }, ...props.sessions.map((s) => ({ value: s.id, label: s.title || s.id }))]);
const parts = computed(() => (props.preview === undefined ? undefined : previewParts(props.preview)));
function tryIt(): void {
  const id = SessionId.safeParse(session.value);
  if (id.success && text.value.trim() !== '') { emit('try', id.data, text.value.trim()); }
}
</script>

<template>
  <UiDialog v-model:open="open" title="Suggestions" description="Who picks the fns and context offered with each message." width="600px">
    <form class="form" novalidate data-testid="decision-form" :data-by="draft.by" @submit.prevent="save">
      <UiSegmented v-model="by" :options="CHOOSERS" label="Who picks" data-testid="decision-by" />
      <p class="dim" data-testid="decision-about">{{ CHOOSER_WORDS[draft.by].about }}</p>
      <template v-if="usesModel">
        <UiField :label="draft.by === 'llm' ? 'LLM' : 'Decision model'" :error="modelError" :required="draft.by === 'llm'">
          <div class="model" data-testid="decision-model">
            <div class="chosen-row">
              <p class="chosen"><span class="dim">Chosen:</span> {{ chosenText }}</p>
              <UiButton
                v-if="draft.by === 'decision' && draft.decision !== ''" size="sm" variant="ghost" icon="undo" data-testid="decision-role-model"
                @click="set('decision', '')"
              >
                Use the Decisions role’s
              </UiButton>
            </div>
            <ModelPicker :models="pickable" :current="picked" :own-choice="false" :limit="100" list-height="min(240px, 32vh)" @pick="pick" />
            <p v-if="draft.by === 'decision' && pickable.length === 0" class="dim">No provider offers a decision model yet: add one (an Ollama System One model, or a system’s provider).</p>
          </div>
        </UiField>
        <div class="numbers">
          <UiInput :model-value="draft.messages" type="number" label="Recent messages" hint="Of the person’s, 1 to 20." @update:model-value="set('messages', $event)" />
          <UiInput :model-value="draft.candidates" type="number" label="Candidates" hint="The best scoring, up to 50." @update:model-value="set('candidates', $event)" />
          <UiInput :model-value="draft.floor" type="number" label="Lowest score" hint="0 to 1." @update:model-value="set('floor', $event)" />
          <UiInput :model-value="draft.cap" type="number" label="Most it picks" hint="Up to 20." @update:model-value="set('cap', $event)" />
        </div>
      </template>
      <UiBanner v-if="numbersError !== ''" tone="danger">{{ numbersError }}</UiBanner>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>

      <fieldset class="try" data-testid="decision-try">
        <legend>Try it, as saved</legend>
        <div class="try-row">
          <UiSelect v-model="session" class="session" :options="sessionOptions" label="Session" hide-label size="sm" />
          <UiInput v-model="text" class="text" label="Message" hide-label placeholder="A message to suggest for" size="sm" @keydown.enter.prevent="tryIt" />
          <UiButton size="sm" variant="secondary" icon="play" :loading="previewing" :disabled="session === '' || text.trim() === ''" data-testid="decision-try-run" @click="tryIt">Try</UiButton>
        </div>
        <p v-if="previewProblem !== ''" class="bad" role="alert">{{ previewProblem }}</p>
        <ul v-if="parts" class="outcomes" data-testid="decision-preview">
          <li v-for="item in parts.used" :key="`u${item.name}`" class="used"><FnPill v-if="item.kind === 'fn'" :name="item.name" /><code v-else>{{ item.name }}</code><span class="dim">{{ item.kind }}{{ item.score === undefined ? '' : ` · ${item.score.toFixed(2)}` }}{{ item.note ? ` · ${item.note}` : '' }}</span></li>
          <li v-for="{ item, why } in parts.left" :key="`l${item.name}`" class="left"><FnPill v-if="item.kind === 'fn'" :name="item.name" /><code v-else>{{ item.name }}</code><span class="dim">{{ why }}</span></li>
          <li v-if="parts.used.length + parts.left.length === 0" class="dim">Nothing to suggest for that.</li>
        </ul>
      </fieldset>
    </form>
    <template #footer>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
      <UiButton variant="primary" :loading="busy" data-testid="decision-save" @click="save">Save</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); }
.model { display: grid; gap: var(--space-2); min-width: 0; }
.chosen-row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; justify-content: space-between; }
.chosen { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.numbers { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 7rem), 1fr)); gap: var(--space-3); }
.try { display: grid; gap: var(--space-2); margin: 0; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); min-width: 0; }
.try legend { padding: 0 var(--space-1); font-size: var(--text-sm); font-weight: var(--weight-medium); }
.try-row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.session { flex: 0 1 12rem; min-width: 0; }
.text { flex: 1 1 12rem; min-width: 0; }
.bad { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.outcomes { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: var(--text-sm); }
.outcomes li { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: baseline; }
.left code { color: var(--text-faint); text-decoration: line-through; }
</style>
