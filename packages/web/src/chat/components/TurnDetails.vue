<script setup lang="ts">
/** An answer's details: models, tokens in and out, cost, time to first token, duration and iterations, with each LLM call one click away. */
import type { LlmInteraction, LlmInteractionId } from '@harness/core';
import { computed } from 'vue';
import { UiBanner, UiSkeleton } from '../../ui/index.ts';
import { formatCost, formatDuration, formatTokens } from '../logic/format.ts';
import { turnUsage } from '../logic/inspect.ts';

const props = withDefaults(defineProps<{ calls: readonly LlmInteraction[]; loading: boolean; problem?: string }>(), { problem: '' });
const emit = defineEmits<{ llm: [id: LlmInteractionId] }>();
const usage = computed(() => turnUsage(props.calls));
</script>

<template>
  <div class="turn" data-testid="turn-details">
    <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
    <UiSkeleton v-if="loading && calls.length === 0" shape="lines" :lines="5" />
    <template v-else>
      <dl class="facts">
        <dt>Models</dt><dd>{{ usage.models.join(', ') || '—' }}<span v-if="usage.providers.length > 0" class="dim"> · {{ usage.providers.join(', ') }}</span></dd>
        <dt>Tokens</dt><dd data-testid="turn-tokens">{{ formatTokens(usage.input) }} in · {{ formatTokens(usage.output) }} out</dd>
        <dt>Cost</dt><dd data-testid="turn-cost">{{ formatCost(usage.cost) }}</dd>
        <template v-if="usage.firstToken !== undefined"><dt>First token</dt><dd>{{ formatDuration(usage.firstToken) }}</dd></template>
        <template v-if="usage.duration !== undefined"><dt>Took</dt><dd>{{ formatDuration(usage.duration) }}</dd></template>
        <dt>Iterations</dt><dd>{{ usage.calls }}</dd>
      </dl>
      <h3 class="heading">LLM calls</h3>
      <ol class="calls">
        <li v-for="call in calls" :key="call.id">
          <button type="button" class="call" data-testid="turn-llm" @click="emit('llm', call.id)">
            <span class="model">{{ call.model }}</span>
            <span class="stats">{{ call.usage ? `${formatTokens(call.usage.input)} → ${formatTokens(call.usage.output)}` : call.status }} · {{ formatCost(call.cost) }}</span>
          </button>
        </li>
        <li v-if="calls.length === 0" class="none">No LLM calls in this turn.</li>
      </ol>
    </template>
  </div>
</template>

<style scoped>
.turn { display: grid; gap: var(--space-4); min-width: 0; }
.facts { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-faint); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dim { color: var(--text-faint); }
.heading { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-strong); }
.calls { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.call { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); width: 100%; min-height: 40px; padding: 0 var(--space-3); border: 0; border-radius: var(--radius); background: transparent; color: var(--text); text-align: left; }
.call:hover { background: var(--surface-2); }
.call:focus-visible { outline: none; box-shadow: var(--ring); }
.model { min-width: 0; font-family: var(--mono); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats { flex: none; color: var(--text-faint); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.none { color: var(--text-faint); font-size: var(--text-sm); }
</style>
