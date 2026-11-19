<script setup lang="ts">
/**
 * A widget `widgets/make_widget` proposed (authoring-save: the agent proposes, the chat shows a preview, the person
 * presses Save), drawn as `make_widget`'s result renderer. Its title, what it shows and the widget it changes; the
 * preview drawn with the app's result view as the widget will be (open at once when the person asked to see something,
 * else one tap away); Save, which runs `widgets/save_widget` as the person, waits for that run in the chat and then
 * links to the saved widget on the widgets page; and Change, which puts a request to change it in the composer.
 * Nothing is saved until Save. Outside a chat (no `CHAT_HOST`) it shows the proposal and its preview only. It draws
 * with the app's own buttons and badge (`APP_COMPONENTS`).
 */
import { APP_COMPONENTS, CHAT_HOST, RESULT_VIEW, type ResultViewOf } from '@harness/sdk';
import { Json, type QualifiedName } from '@harness/core';
import { computed, inject, ref } from 'vue';
import type { widgets } from '../shared/index.ts';
import { changeRequest, saveArgs, savedName, widgetsPageHref } from './proposal.ts';

const props = defineProps<ResultViewOf<typeof widgets, 'make_widget'>>();

const ResultView = inject(RESULT_VIEW, undefined);
const chat = inject(CHAT_HOST, undefined);
const parts = inject(APP_COMPONENTS, undefined);
const preview = computed(() => Json.parse(props.result.preview));
const showing = ref(props.result.show);
const saving = ref(false);
const saved = ref<QualifiedName | undefined>(undefined);
const problem = ref('');
const savedHref = computed(() => (saved.value === undefined ? '' : widgetsPageHref(saved.value)));

async function save(): Promise<void> {
  if (chat === undefined || saving.value) { return; }
  saving.value = true;
  problem.value = '';
  try {
    const run = await props.system.run.save_widget(saveArgs(props.result));
    const outcome = await chat.settled(run);
    if (outcome.ok) { saved.value = savedName(props.result); } else { problem.value = outcome.problem; }
  } catch (error) {
    problem.value = error instanceof Error ? error.message : "Couldn't save the widget.";
  } finally {
    saving.value = false;
  }
}

async function change(): Promise<void> {
  await chat?.ask(changeRequest(props.result), false);
}

function openSaved(): void { chat?.navigate(savedHref.value); }
</script>

<template>
  <article class="proposal" data-testid="widget-proposal" :data-name="result.name">
    <header class="head">
      <div class="words">
        <h3 class="title">
          {{ result.spec.title }}
          <component :is="parts.Badge" v-if="parts && result.replaces" tone="neutral" data-testid="widget-proposal-replaces">changes {{ result.replaces }}</component>
        </h3>
        <p class="description">{{ result.description }}</p>
      </div>
      <div v-if="parts" class="buttons">
        <component :is="parts.Button" v-if="!showing" size="sm" variant="ghost" icon="eye" data-testid="widget-proposal-show" @click="showing = true">Preview</component>
        <component :is="parts.Button" v-if="chat && saved === undefined" size="sm" variant="ghost" icon="edit" data-testid="widget-proposal-change" @click="change">Change</component>
        <component :is="parts.Button" v-if="chat && saved === undefined" size="sm" variant="primary" icon="check" :loading="saving" data-testid="widget-proposal-save" @click="save">Save</component>
        <a v-if="saved" class="saved" :href="savedHref" data-testid="widget-proposal-saved" @click.prevent="openSaved">Saved as {{ saved }}</a>
      </div>
    </header>
    <p v-if="problem !== ''" class="problem" role="alert">{{ problem }}</p>
    <component :is="ResultView" v-if="showing && ResultView" :value="preview" :title="result.spec.title" :view-key="`${run}:preview`" />
  </article>
</template>

<style scoped>
.proposal { display: grid; gap: var(--space-2); min-width: 0; }
.head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.words { display: grid; flex: 1 1 16rem; gap: 2px; min-width: 0; }
.title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.description { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.buttons { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); }
.saved { color: var(--accent); font-size: var(--text-sm); text-decoration: none; }
.saved:hover { text-decoration: underline; }
.problem { margin: 0; color: var(--danger); font-size: var(--text-sm); }
</style>
