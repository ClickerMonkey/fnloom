<script setup lang="ts">
/**
 * The decision model for suggestions: on or off (off, the score threshold alone decides), the model, how many of the
 * person's recent messages it reads, how many candidates above which score it sees and the most it picks. "Try it"
 * shows what would be suggested for a message in a session now: what is used and what is left out, with each reason.
 */
import { SessionId, type ModelInfo, type SessionSummary, type SuggestDecision, type SuggestDecisionView, type SuggestionRecord } from '@harness/core';
import { computed, ref, watch } from 'vue';
import ModelPicker from '../../chat/components/ModelPicker.vue';
import type { ModelPick } from '../../chat/logic/session.ts';
import { UiBanner, UiButton, UiDialog, UiField, UiInput, UiSelect, UiSwitch, type SelectOption } from '../../ui/index.ts';
import { decisionDraft, decisionOf, previewParts, type DecisionDraft } from '../logic/suggestions.ts';

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

const checked = computed(() => decisionOf(draft.value));
const modelError = computed(() => (tried.value && !checked.value.ok && checked.value.at === 'model' ? checked.value.problem : ''));
const numbersError = computed(() => (tried.value && !checked.value.ok && checked.value.at === 'numbers' ? checked.value.problem : ''));
const picked = computed<ModelPick>(() => (draft.value.model === '' ? 'default' : `model:${draft.value.model}`));
function pick(choice: ModelPick): void {
  if (choice !== 'default') { set('model', choice.slice('model:'.length)); }
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
  <UiDialog v-model:open="open" title="Decision model" description="A model reads the person’s last few messages and the candidates, and picks what to suggest." width="600px">
    <form class="form" novalidate data-testid="decision-form" @submit.prevent="save">
      <UiSwitch :model-value="draft.enabled" label="Use a decision model" description="Off: anything scoring above the threshold is suggested." data-testid="decision-enabled" @update:model-value="set('enabled', $event)" />
      <UiField label="Model" :error="modelError">
        <div class="model" data-testid="decision-model">
          <p class="chosen"><span class="dim">Chosen:</span> {{ draft.model || 'None yet' }}</p>
          <ModelPicker :models="models" :current="picked" :own-choice="false" :limit="100" list-height="min(240px, 32vh)" @pick="pick" />
        </div>
      </UiField>
      <div class="numbers">
        <UiInput :model-value="draft.messages" type="number" label="Recent messages" hint="Of the person’s, 1 to 20." @update:model-value="set('messages', $event)" />
        <UiInput :model-value="draft.candidates" type="number" label="Candidates" hint="The best scoring, up to 50." @update:model-value="set('candidates', $event)" />
        <UiInput :model-value="draft.floor" type="number" label="Lowest score" hint="0 to 1." @update:model-value="set('floor', $event)" />
        <UiInput :model-value="draft.cap" type="number" label="Most it picks" hint="Up to 20." @update:model-value="set('cap', $event)" />
      </div>
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
          <li v-for="item in parts.used" :key="`u${item.name}`" class="used"><code>{{ item.name }}</code><span class="dim">{{ item.kind }}{{ item.score === undefined ? '' : ` · ${item.score.toFixed(2)}` }}</span></li>
          <li v-for="{ item, why } in parts.left" :key="`l${item.name}`" class="left"><code>{{ item.name }}</code><span class="dim">{{ why }}</span></li>
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
.chosen { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
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
