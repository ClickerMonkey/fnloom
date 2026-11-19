<script setup lang="ts">
/**
 * A chat's settings: who answers and with which model, how its prompt is made (the chat mode and the contextor,
 * each the agent's or this chat's own, and a dry run of what a message would get), its system prompt (the agent's
 * instructions, or this chat's own, as an A/B compare's "Keep its settings" may set), (the agent's own choice, or one model for this chat), how urgent its turns are (its priority, as the hub resolved it), how you hear
 * about it (every message, replies to you, nothing), which systems it uses (each with its status, names, switches
 * and badges in fixed columns), and who is in it. Changes save as they are made.
 */
import {
  PRIORITIES, type ChatCapabilities, type ChatModeConfig, type ContextorConfig, type NotifyChoice, type Priority, type QualifiedName, type SelectionReport, type Session, type SystemName,
} from '@harness/core';
import { computed, ref, watch } from 'vue';
import { UiBadge, UiButton, UiSegmented, UiSelect, UiSwitch, UiTextarea, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { humanize } from '../logic/labels.ts';
import { agentOptions, modelLabel } from '../logic/session.ts';
import { CONTEXTOR_CHOICES, contextorFrom, defaultContextor, defaultMode, MODE_CHOICES, modeFrom } from '../logic/modes.ts';
import ChatModeSettings from './ChatModeSettings.vue';
import SelectionPreview from './SelectionPreview.vue';
import SessionPeople from './SessionPeople.vue';

const props = withDefaults(defineProps<{
  session: Session;
  systems: ChatCapabilities['systems'];
  notify: NotifyChoice;
  agent: string;
  /** The agents that can answer here. */
  agents?: ChatCapabilities['agents'];
  /** The models the hub can call. */
  models?: ChatCapabilities['models'];
  /** The priority its turns get now, once the hub has said. */
  priority?: Priority | undefined;
  /** A person's or agent's name. */
  nameOf: (actor: Session['participants'][number]) => string;
  /** The dry run of this chat's contextor for a message, once one was asked for. */
  preview?: { readonly report: SelectionReport | undefined; readonly loading: boolean; readonly problem: string };
  /** A change of the session is on its way to the hub. */
  saving?: boolean;
}>(), { priority: undefined, agents: () => [], models: () => [], preview: () => ({ report: undefined, loading: false, problem: '' }), saving: false });
const emit = defineEmits<{
  notify: [choice: NotifyChoice]; systems: [systems: SystemName[] | 'all']; priority: [priority: Priority]; agent: [fn: QualifiedName];
  /** The person wants to change the model: the chat opens the model picker. */
  pickModel: [];
  /** This chat's chat mode or contextor; `null` goes back to the agent's. */
  mode: [mode: ChatModeConfig | null];
  contextor: [contextor: ContextorConfig | null];
  /** This chat's system prompt; `null` goes back to the agent's own instructions. */
  instructions: [text: string | null];
  /** Ask what a message would get from the contextor now. */
  preview: [text: string];
}>();

/** The system prompt being edited, saved with Save (long text, so not on every key). */
const prompt = ref(props.session.instructions ?? '');
watch(() => props.session.instructions, (now) => { prompt.value = now ?? ''; });
const promptChanged = computed(() => prompt.value.trim() !== (props.session.instructions ?? '').trim());
function savePrompt(): void { emit('instructions', prompt.value.trim() === '' ? null : prompt.value); }

const agentChoices = computed<SelectOption<QualifiedName>[]>(() => agentOptions(props.agents, props.session.agent).map((a) => ({ value: a.fn, label: a.name })));
const agentAbout = computed(() => agentOptions(props.agents, props.session.agent)[0]?.description ?? '');
const model = computed(() => modelLabel(props.session.model, props.models));

const PRIORITY: readonly SegmentOption<Priority>[] = PRIORITIES.map((p) => ({ value: p, label: humanize(p) }));

const NOTIFY: readonly SegmentOption<NotifyChoice>[] = [{ value: 'all', label: 'Every message' }, { value: 'replies', label: 'Replies to me' }, { value: 'none', label: 'Nothing' }];

const enabled = computed(() => new Set(props.session.systems === 'all' ? props.systems.map((s) => s.name) : props.session.systems));

function toggle(name: SystemName, on: boolean): void {
  const next = props.systems.map((s) => s.name).filter((n) => (n === name ? on : enabled.value.has(n)));
  emit('systems', next.length === props.systems.length ? 'all' : next);
}
</script>

<template>
  <div class="settings" data-testid="session-settings">
    <section class="section">
      <h3 class="heading">Agent</h3>
      <UiSelect
        :model-value="session.agent" :options="agentChoices" label="Who answers" hide-label data-testid="session-agent"
        @update:model-value="$event !== session.agent && emit('agent', $event)"
      />
      <p class="dim">{{ agentAbout === '' ? `${agent} answers in this chat.` : agentAbout }}</p>
    </section>
    <section class="section">
      <h3 class="heading">Model</h3>
      <div class="model" data-testid="session-model">
        <span class="model-name">{{ model }}</span>
        <UiButton size="sm" icon="cpu" data-testid="change-model" @click="emit('pickModel')">Change</UiButton>
      </div>
      <p class="dim">The agent answers with this model here. Budgets and an admin's rules still apply.</p>
    </section>
    <section class="section" data-testid="session-prompt">
      <h3 class="heading">Chat mode</h3>
      <ChatModeSettings
        label="Chat mode" :value="session.mode" :choices="MODE_CHOICES" :defaults="defaultMode" :read="modeFrom" :busy="saving" testid="session-mode"
        @change="emit('mode', $event)"
      />
    </section>
    <section class="section">
      <h3 class="heading">System prompt</h3>
      <UiTextarea v-model="prompt" label="System prompt" hide-label :rows="2" :max-rows="10" placeholder="The agent’s own instructions" data-testid="session-instructions" />
      <div v-if="promptChanged || session.instructions !== undefined" class="prompt-actions">
        <UiButton v-if="session.instructions !== undefined" size="sm" variant="ghost" :disabled="saving" data-testid="session-instructions-clear" @click="emit('instructions', null)">Use the agent’s</UiButton>
        <UiButton v-if="promptChanged" size="sm" variant="primary" :loading="saving" data-testid="session-instructions-save" @click="savePrompt">Save</UiButton>
      </div>
      <p class="dim">{{ session.instructions === undefined ? 'The agent answers with its own instructions. Write here to give this chat its own.' : 'This chat’s own prompt, instead of the agent’s instructions.' }}</p>
    </section>
    <section class="section">
      <h3 class="heading">Context</h3>
      <ChatModeSettings
        label="Contextor" :value="session.contextor" :choices="CONTEXTOR_CHOICES" :defaults="defaultContextor" :read="contextorFrom" :busy="saving" testid="session-contextor"
        @change="emit('contextor', $event)"
      />
      <details class="try" data-testid="preview-details">
        <summary>What would a message get?</summary>
        <SelectionPreview :report="preview.report" :loading="preview.loading" :problem="preview.problem" @preview="emit('preview', $event)" />
      </details>
    </section>
    <section v-if="priority" class="section">
      <h3 class="heading">Priority</h3>
      <UiSegmented class="fill" :model-value="priority" :options="PRIORITY" label="Priority" data-testid="session-priority" @update:model-value="emit('priority', $event)" />
      <p class="dim">Busy hubs run urgent turns first. Rules an admin set may cap it.</p>
    </section>
    <section class="section">
      <h3 class="heading">Notify me about</h3>
      <UiSegmented :model-value="notify" :options="NOTIFY" label="Notify me about" data-testid="session-notify" @update:model-value="emit('notify', $event)" />
    </section>
    <section class="section">
      <h3 class="heading">Systems</h3>
      <p class="dim">Only these systems’ fns, context, mentions and hooks apply here.</p>
      <ul class="systems">
        <li v-for="system in systems" :key="system.name" class="system" :data-system="system.name">
          <span class="system-name">{{ system.name }}</span>
          <UiBadge :tone="system.status === 'connected' ? 'ok' : system.status === 'needs-config' ? 'warn' : 'neutral'">{{ humanize(system.status) }}</UiBadge>
          <UiSwitch :model-value="enabled.has(system.name)" :label="`Use ${system.name}`" hide-label :disabled="!system.enabled" @update:model-value="toggle(system.name, $event)" />
        </li>
        <li v-if="systems.length === 0" class="dim">No systems are connected.</li>
      </ul>
    </section>
    <section class="section">
      <h3 class="heading">People</h3>
      <SessionPeople :participants="session.participants" :name-of="nameOf" />
    </section>
  </div>
</template>

<style scoped>
.settings { display: grid; gap: var(--space-5); min-width: 0; }
.section { display: grid; gap: var(--space-2); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
.prompt-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.model { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 40px; }
.model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
.systems { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.system { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); min-height: 40px; }
.system-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fill { width: 100%; }
.try { display: grid; gap: var(--space-3); }
.try > summary { color: var(--accent); font-size: var(--text-sm); font-weight: var(--weight-medium); cursor: pointer; }
.try[open] > summary { margin-bottom: var(--space-3); }
</style>
