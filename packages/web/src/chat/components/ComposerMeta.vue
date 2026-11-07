<script setup lang="ts">
/**
 * The quiet row under the composer: the agent answering, how many systems the chat uses (and how many are offline),
 * background work, and the cost and budget meter. On a phone it keeps to one line, dropping words before numbers.
 */
import { UiIcon } from '../../ui/index.ts';
import type { BudgetMeter as Meter } from '../logic/session.ts';
import BudgetMeter from './BudgetMeter.vue';

withDefaults(defineProps<{
  agent: string;
  /** A switch of agent waiting for the next message. */
  pendingAgent?: string;
  systems: { readonly total: number; readonly offline: number };
  background: number;
  spent: number;
  meter?: Meter | undefined;
  compact: boolean;
}>(), { pendingAgent: '', meter: undefined });

const emit = defineEmits<{ settings: []; background: [] }>();
</script>

<template>
  <div class="meta" :class="{ compact }" data-testid="composer-meta">
    <button type="button" class="item agent" :title="pendingAgent === '' ? agent : `Switching to ${pendingAgent} on your next message`" @click="emit('settings')">
      <UiIcon name="sparkles" :size="14" />
      <span class="text">{{ pendingAgent === '' ? agent : `→ ${pendingAgent}` }}</span>
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
.agent { flex-shrink: 1; }
.text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
</style>
