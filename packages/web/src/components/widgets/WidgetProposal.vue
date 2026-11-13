<script setup lang="ts">
/**
 * A widget `widgets/make_widget` proposed (authoring-save: the agent proposes, the chat shows a preview, the person
 * presses Save). Its title, what it shows and the source it draws from; the preview drawn as the widget will be
 * (open at once when the person asked to see something, else one tap away); Save, which runs `widgets/save_widget` as
 * the person and then links to the saved widget; and Change, which puts a request to change it in the composer.
 * Nothing is saved until Save.
 */
import { Json, QualifiedName, WIDGETS_SYSTEM, type WidgetProposal } from '@harness/core';
import { computed, inject, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { links } from '../../app/routes.ts';
import { UiBadge, UiButton } from '../../ui/index.ts';
import { resultFrame } from './widget-source.ts';
import WidgetView from './WidgetView.vue';
import { changeWidgetRequest, SAVE_WIDGET_FN, saveArgs, WIDGET_HOST } from './widgets.ts';

const props = withDefaults(defineProps<{ proposal: WidgetProposal; viewKey?: string }>(), { viewKey: '' });

const host = inject(WIDGET_HOST, undefined);
const frame = computed(() => resultFrame(props.proposal.preview));
const showing = ref(props.proposal.show);
const saving = ref(false);
const saved = ref<QualifiedName | undefined>(undefined);
const problem = ref('');

async function save(): Promise<void> {
  if (host === undefined || saving.value) { return; }
  saving.value = true;
  problem.value = '';
  const ran = await host.run(SAVE_WIDGET_FN, Json.parse(saveArgs(props.proposal)));
  saving.value = false;
  if (ran.ok) { saved.value = props.proposal.replaces ?? QualifiedName.parse(`${WIDGETS_SYSTEM}/${props.proposal.name}`); } else { problem.value = ran.problem; }
}

async function change(): Promise<void> {
  await host?.ask?.(changeWidgetRequest(props.proposal), false);
}
</script>

<template>
  <article class="proposal" data-testid="widget-proposal" :data-name="proposal.name">
    <header class="head">
      <div class="words">
        <h3 class="title">{{ proposal.spec.title }} <UiBadge v-if="proposal.replaces" tone="neutral">changes {{ proposal.replaces }}</UiBadge></h3>
        <p class="description">{{ proposal.description }}</p>
      </div>
      <div class="buttons">
        <UiButton v-if="!showing" size="sm" variant="ghost" icon="eye" data-testid="widget-proposal-show" @click="showing = true">Preview</UiButton>
        <UiButton v-if="host?.ask && saved === undefined" size="sm" variant="ghost" icon="edit" data-testid="widget-proposal-change" @click="change">Change</UiButton>
        <UiButton v-if="host && saved === undefined" size="sm" variant="primary" icon="check" :loading="saving" data-testid="widget-proposal-save" @click="save">Save</UiButton>
        <RouterLink v-if="saved" class="saved" :to="links.fn(saved)" data-testid="widget-proposal-saved">Saved as {{ saved }}</RouterLink>
      </div>
    </header>
    <p v-if="problem !== ''" class="problem" role="alert">{{ problem }}</p>
    <WidgetView v-if="showing" :frame="frame" :view-key="viewKey" :show-title="false" />
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
