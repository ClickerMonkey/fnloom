<script setup lang="ts">
/**
 * One model call, whole: its modality, model and provider, what it used in its own units, cost, how long it waited,
 * until the first byte and in all, how much it sent and received, what it was for (the run, its chat, or the hub's own
 * purpose) and its error; for a chat call, what the model saw and said (the LLM call's details) below, which give its
 * model, tokens, cost and timing, so those aren't said twice.
 */
import type { LlmInteraction, ModelCall, RunId, SessionId } from '@harness/core';
import LlmCallDetails from '../../chat/components/LlmCallDetails.vue';
import { formatCost, formatDuration } from '../../chat/logic/format.ts';
import type { LlmCallTab } from '../../chat/logic/inspect.ts';
import { UiButton, UiIcon, fullTime } from '../../ui/index.ts';
import { callPurpose, MODALITY_WORDS, MODEL_CALL_STATUS_LOOK, sizeText, unitsText } from '../logic/model-calls.ts';
import StatusBadge from './StatusBadge.vue';

defineProps<{ call: ModelCall; interaction?: LlmInteraction | undefined }>();
const emit = defineEmits<{ run: [run: RunId]; session: [session: SessionId] }>();
/** The chat call's tab, which a parent keeps in the URL. */
const tab = defineModel<LlmCallTab>('tab', { default: 'saw' });
</script>

<template>
  <div class="details" data-testid="model-call" :data-modality="call.modality">
    <p class="head">
      <span class="modality"><UiIcon :name="MODALITY_WORDS[call.modality].icon" :size="16" />{{ MODALITY_WORDS[call.modality].label }}</span>
      <StatusBadge :look="MODEL_CALL_STATUS_LOOK[call.status]" />
    </p>
    <dl class="facts">
      <template v-if="!interaction">
        <dt>Model</dt><dd><code>{{ call.model }}</code> · {{ call.provider }}</dd>
        <dt>Used</dt><dd data-testid="model-call-units">{{ unitsText(call.units) }}</dd>
        <dt>Cost</dt><dd>{{ formatCost(call.cost) }}</dd>
      </template>
      <dt>Waited</dt><dd>{{ formatDuration(call.queued) }}</dd>
      <template v-if="!interaction">
        <template v-if="call.firstByte !== undefined"><dt>First byte</dt><dd>{{ formatDuration(call.firstByte) }}</dd></template>
        <template v-if="call.total !== undefined"><dt>Took</dt><dd>{{ formatDuration(call.total) }}</dd></template>
      </template>
      <dt>Size</dt><dd>{{ sizeText(call) }}</dd>
      <dt>For</dt><dd>{{ callPurpose(call) }}<span v-if="call.priority" class="dim"> · {{ call.priority }}</span></dd>
      <dt v-if="!interaction">Started</dt><dd v-if="!interaction">{{ fullTime(call.startedAt) }}</dd>
      <template v-if="call.error"><dt>Error</dt><dd class="error">{{ call.error }}</dd></template>
    </dl>
    <div v-if="call.run || call.session" class="links">
      <UiButton v-if="call.run" size="sm" variant="ghost" icon="fn" @click="call.run && emit('run', call.run)">The run that asked</UiButton>
      <UiButton v-if="call.session" size="sm" variant="ghost" icon="chat" @click="call.session && emit('session', call.session)">Its chat</UiButton>
    </div>
    <LlmCallDetails v-if="interaction" v-model:tab="tab" :call="interaction" />
  </div>
</template>

<style scoped>
.details { display: grid; gap: var(--space-4); min-width: 0; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; }
.modality { display: inline-flex; align-items: center; gap: var(--space-1); font-weight: var(--weight-medium); }
.facts { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-faint); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dim { color: var(--text-faint); }
.error { color: var(--danger); }
.links { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
