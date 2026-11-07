<script setup lang="ts">
/**
 * The quiet row under the composer: the agent answering (a menu switches it), the model it answers with (opening the
 * model picker to change it), how many systems the chat uses (and how many are offline), background work, and the
 * cost and budget meter. On a phone it keeps to one line, dropping words before numbers.
 */
import type { QualifiedName } from '@harness/core';
import { computed } from 'vue';
import { UiIcon, UiMenu, type MenuItem } from '../../ui/index.ts';
import type { BudgetMeter as Meter } from '../logic/session.ts';
import BudgetMeter from './BudgetMeter.vue';

const props = withDefaults(defineProps<{
  agent: string;
  /** The agents the chat can switch to, the current one first. */
  agents?: readonly { readonly fn: QualifiedName; readonly name: string }[];
  /** The model the agent answers with, in words. */
  model?: string;
  systems: { readonly total: number; readonly offline: number };
  background: number;
  spent: number;
  meter?: Meter | undefined;
  compact: boolean;
}>(), { agents: () => [], model: '', meter: undefined });

const emit = defineEmits<{ settings: []; model: []; background: []; agent: [fn: QualifiedName] }>();

/** The agent menu: every agent (the current one checked), then the chat's settings. */
const agentItems = computed<MenuItem<QualifiedName | 'settings'>[]>(() => [
  ...props.agents.map((a, at) => ({ value: a.fn, label: a.name, icon: at === 0 ? 'check' as const : 'sparkles' as const })),
  ...(props.agents.length > 0 ? [{ kind: 'separator' as const }] : []),
  { value: 'settings', label: 'Chat settings…', icon: 'settings' },
]);

function chooseAgent(value: QualifiedName | 'settings'): void {
  if (value === 'settings') { emit('settings'); return; }
  if (value !== props.agents[0]?.fn) { emit('agent', value); }
}
</script>

<template>
  <div class="meta" :class="{ compact }" data-testid="composer-meta">
    <UiMenu :items="agentItems" label="Who answers" side="top" align="start" @select="chooseAgent">
      <template #trigger="{ toggle, attrs }">
        <button type="button" class="item agent" :title="`${agent} answers here`" v-bind="attrs" data-testid="agent-picker" @click="toggle">
          <UiIcon name="sparkles" :size="14" />
          <span class="text">{{ agent }}</span>
          <UiIcon name="chevron-down" :size="12" />
        </button>
      </template>
    </UiMenu>
    <button v-if="model !== '' && !compact" type="button" class="item model" :title="`Answers with ${model}`" data-testid="model-chip" @click="emit('model')">
      <UiIcon name="cpu" :size="14" />
      <span class="text">{{ model }}</span>
    </button>
    <button type="button" class="item" :class="{ warn: systems.offline > 0 }" :title="`${systems.total} systems, ${systems.offline} offline`" @click="emit('settings')">
      <UiIcon name="server" :size="14" />
      <span class="text">{{ systems.total }}<span v-if="!compact"> system{{ systems.total === 1 ? '' : 's' }}</span><span v-if="systems.offline > 0"> · {{ systems.offline }} offline</span></span>
    </button>
    <button v-if="background > 0" type="button" class="item" data-testid="background-count" @click="emit('background')">
      <UiIcon name="clock" :size="14" />
      <span class="text">{{ background }}<span v-if="!compact"> in background</span></span>
    </button>
    <span class="spacer" />
    <BudgetMeter :spent="spent" :meter="meter" :compact="compact" />
  </div>
</template>

<style scoped>
.meta { display: flex; align-items: center; gap: var(--space-1); min-width: 0; overflow: hidden; }
.item {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 28px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-full);
  background: transparent; color: var(--text-faint); font-size: var(--text-xs); white-space: nowrap;
}
.item:hover { background: var(--surface-2); color: var(--text-dim); }
.item:focus-visible { outline: none; box-shadow: var(--ring); }
.item.warn { color: var(--warn); }
.agent, .model { flex-shrink: 1; }
.model { max-width: 220px; }
.text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
</style>
