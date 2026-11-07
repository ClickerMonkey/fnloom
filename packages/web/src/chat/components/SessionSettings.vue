<script setup lang="ts">
/**
 * A chat's settings: who answers and with which model (the agent's own choice, or one model for this chat), how urgent its turns are (its priority, as the hub resolved it), how you hear
 * about it (every message, replies to you, nothing), which systems it uses (each with its status, names, switches
 * and badges in fixed columns), and who is in it. Changes save as they are made.
 */
import { PRIORITIES, type ChatCapabilities, type NotifyChoice, type Priority, type QualifiedName, type Session, type SystemName } from '@harness/core';
import { computed } from 'vue';
import { UiBadge, UiButton, UiSegmented, UiSelect, UiSwitch, type SegmentOption, type SelectOption } from '../../ui/index.ts';
import { humanize } from '../logic/labels.ts';
import { agentOptions, modelLabel } from '../logic/session.ts';
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
}>(), { priority: undefined, agents: () => [], models: () => [] });
const emit = defineEmits<{
  notify: [choice: NotifyChoice]; systems: [systems: SystemName[] | 'all']; priority: [priority: Priority]; agent: [fn: QualifiedName];
  /** The person wants to change the model: the chat opens the model picker. */
  pickModel: [];
}>();

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
.model { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 40px; }
.model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--weight-medium); }
.systems { display: grid; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.system { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--space-3); min-height: 40px; }
.system-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fill { width: 100%; }
</style>
