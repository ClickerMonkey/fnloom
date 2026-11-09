<script setup lang="ts">
/**
 * An input fn's form in the chat (every input fn's renderer and the `form` kind's draw it, see `index.ts`): its title and description, its fields (the chat's gin value editor when it gives
 * one, else the form's own inputs), and the button. Sending adds the answers as a hidden user message (one
 * `input-answer` part); then the form shows "Answered" with the values. Under a form that wasn't a saved one,
 * "Save this form for next time" keeps it as an `input` fn (name, description and, with more than one person, who
 * may use it: the app's visibility editor, people and groups included, or Only me / Everyone without it).
 */
import { VISIBILITY_LABELS, type FnError, type Json, type RunId, type ShareRule, type Visibility } from '@harness/core';
import type { SystemClient } from '@harness/sdk';
import { computed, inject, ref, shallowRef } from 'vue';
import type { InputContract } from '../shared/index.ts';
import FieldInput from './FieldInput.vue';
import { answerFor, askedOf, checkAnswers, fieldsOf, shownValue, type FormValues } from './form.ts';
import { ACCESS_INFO, INPUT_ANSWERS, SHARE_EDITOR, VALUE_EDITOR } from './host.ts';

const view = defineProps<{ run: RunId; result?: unknown; error?: FnError | undefined; system: SystemClient<InputContract['defs']> }>();

const answers = inject(INPUT_ANSWERS, undefined);
const editor = inject(VALUE_EDITOR, undefined);
const access = inject(ACCESS_INFO, undefined);
const shareEditor = inject(SHARE_EDITOR, undefined);

const asked = computed(() => askedOf(view.result));
const fields = computed(() => (asked.value === undefined ? [] : fieldsOf(asked.value.form.type)));
// shallow: JSON is recursive, and the values are replaced, never changed in place
const values = shallowRef<FormValues>({});
const whole = shallowRef<Json | undefined>(undefined);
const problem = ref('');
const sending = ref(false);
const sentNow = shallowRef<Json | undefined>(undefined);

function setValue(key: string, value: Json | undefined): void {
  values.value = { ...values.value, [key]: value };
}
const answered = computed(() => answers?.answerOf(view.run)?.value ?? sentNow.value);

const saving = ref<'closed' | 'open' | 'busy' | 'saved'>('closed');
const saveName = ref('');
const saveDescription = ref('');
const saveShare = shallowRef<ShareRule>({ visibility: 'private', with: [] });
const saveProblem = ref('');

async function send(): Promise<void> {
  const form = asked.value;
  if (form === undefined || answers === undefined) { return; }
  const checked = checkAnswers(form.form.type, editor === undefined ? values.value : objectOf(whole.value));
  if ('problem' in checked) { problem.value = checked.problem; return; }
  problem.value = '';
  sending.value = true;
  try {
    await answers.send(answerFor(view.run, form, checked.value));
    sentNow.value = checked.value;
  } catch (error) {
    problem.value = error instanceof Error ? error.message : String(error);
  } finally {
    sending.value = false;
  }
}

function objectOf(value: Json | undefined): FormValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function openSave(): void {
  const form = asked.value;
  if (form === undefined) { return; }
  saveName.value = form.form.title.slice(0, 60);
  saveDescription.value = form.form.description;
  saving.value = 'open';
}

async function save(): Promise<void> {
  const form = asked.value;
  if (form === undefined || saveName.value.trim() === '' || saveDescription.value.trim() === '') { saveProblem.value = 'Give it a name and say what it is for.'; return; }
  const share = saveShare.value;
  if (share.visibility === 'shared' && share.with.length === 0) { saveProblem.value = 'Choose the people or groups to share it with.'; return; }
  saving.value = 'busy';
  saveProblem.value = '';
  try {
    await view.system.run.save_form({
      name: saveName.value.trim(), description: saveDescription.value.trim(), form: form.form, visibility: share.visibility,
      ...(share.visibility === 'shared' ? { with: share.with } : {}),
    });
    saving.value = 'saved';
  } catch (error) {
    saveProblem.value = error instanceof Error ? error.message : String(error);
    saving.value = 'open';
  }
}

/** Without the app's editor there is no people picker, so only the two choices that need none. */
const PLAIN_CHOICES: readonly Visibility[] = ['private', 'public'];
function choose(visibility: Visibility): void {
  saveShare.value = { visibility, with: [] };
}
</script>

<template>
  <article v-if="asked" class="form" :aria-label="asked.form.title">
    <header class="head">
      <h3 class="title">{{ asked.form.title }}</h3>
      <span v-if="answered !== undefined" class="done" role="status">Answered</span>
    </header>
    <p v-if="asked.form.description" class="description">{{ asked.form.description }}</p>

    <dl v-if="answered !== undefined" class="answers">
      <div v-for="field in fields" :key="field.key" class="answer">
        <dt>{{ field.label }}</dt>
        <dd>{{ shownValue(objectOf(answered)[field.key]) }}</dd>
      </div>
    </dl>

    <form v-else class="fields" novalidate @submit.prevent="send">
      <component :is="editor" v-if="editor" v-model="whole" :type="asked.form.type" />
      <template v-else>
        <div v-for="field in fields" :key="field.key" class="field">
          <label class="label" :for="`${run}-${field.key}`">{{ field.label }}<span v-if="!field.required" class="optional"> (optional)</span></label>
          <FieldInput :id="`${run}-${field.key}`" :model-value="values[field.key]" :field="field" :disabled="sending" @update:model-value="setValue(field.key, $event)" />
        </div>
      </template>
      <p v-if="problem" class="problem" role="alert">{{ problem }}</p>
      <p v-if="!answers" class="problem" role="note">This chat can't send form answers yet.</p>
      <div class="actions">
        <button class="primary" type="submit" :disabled="sending || !answers">{{ asked.form.submit ?? 'Send' }}</button>
      </div>
    </form>

    <footer v-if="asked.saved === undefined" class="save">
      <button v-if="saving === 'closed'" class="link" type="button" @click="openSave">Save this form for next time</button>
      <p v-else-if="saving === 'saved'" class="saved" role="status">Saved. It is offered by name next time.</p>
      <form v-else class="save-form" @submit.prevent="save">
        <label class="label" :for="`${run}-save-name`">Name</label>
        <input :id="`${run}-save-name`" v-model="saveName" class="box" type="text" maxlength="60" required>
        <label class="label" :for="`${run}-save-description`">What it is for</label>
        <input :id="`${run}-save-description`" v-model="saveDescription" class="box" type="text" required>
        <template v-if="access?.multiUser">
          <component :is="shareEditor" v-if="shareEditor" v-model="saveShare" label="Who can use it" />
          <template v-else>
            <span class="label">Who can use it</span>
            <div class="segments" role="radiogroup" aria-label="Who can use it">
              <button
                v-for="choice in PLAIN_CHOICES" :key="choice" type="button" role="radio" class="segment"
                :aria-checked="saveShare.visibility === choice" @click="choose(choice)"
              >
                {{ VISIBILITY_LABELS[choice] }}
              </button>
            </div>
          </template>
        </template>
        <p v-if="saveProblem" class="problem" role="alert">{{ saveProblem }}</p>
        <div class="actions">
          <button class="link" type="button" @click="saving = 'closed'">Cancel</button>
          <button class="primary" type="submit" :disabled="saving === 'busy'">Save</button>
        </div>
      </form>
    </footer>
  </article>
  <p v-else-if="view.error" class="problem" role="alert">{{ view.error.message }}</p>
</template>

<style scoped>
.form {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  max-width: 40rem;
}
.head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.title { margin: 0; font-size: var(--text-md); font-weight: 600; overflow-wrap: anywhere; flex: 1; }
.done {
  flex: none;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  color: var(--ok);
  background: var(--ok-soft);
}
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.fields, .save-form { display: grid; gap: var(--space-2); }
.field { display: grid; gap: var(--space-1); }
.label { font-size: var(--text-sm); font-weight: 500; }
.optional { color: var(--text-dim); font-weight: 400; }
.answers { display: grid; gap: var(--space-1); margin: 0; }
.answer { display: grid; grid-template-columns: minmax(6rem, 14rem) 1fr; gap: var(--space-2); font-size: var(--text-sm); }
.answer dt { color: var(--text-dim); overflow-wrap: anywhere; }
.answer dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.primary {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--on-accent, #fff);
  font: inherit;
  cursor: pointer;
}
.primary:disabled { opacity: 0.6; cursor: default; }
.link { padding: 0; border: none; background: none; color: var(--accent); font: inherit; font-size: var(--text-sm); cursor: pointer; justify-self: start; }
.save { border-top: 1px solid var(--border); padding-top: var(--space-2); }
.saved { margin: 0; font-size: var(--text-sm); color: var(--ok); }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
.box {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
.segments { display: flex; flex-wrap: wrap; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; width: fit-content; max-width: 100%; }
.segment { padding: var(--space-1) var(--space-3); border: none; background: var(--surface); color: var(--text); font: inherit; font-size: var(--text-sm); cursor: pointer; }
.segment[aria-checked='true'] { background: var(--accent-soft); color: var(--accent); }
button:focus-visible, .box:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (max-width: 480px) {
  .answer { grid-template-columns: 1fr; gap: 0; }
}
</style>
