<script setup lang="ts">
/**
 * One LLM call, whole: model and provider, tokens, cost, time to first token and duration; what the model saw (the
 * system prompt, each message with the hub's tagged additions picked out, and the tools offered); what it answered
 * (text, reasoning, tool calls); and the raw JSON. Read-only and copyable.
 */
import type { LlmInteraction } from '@harness/core';
import { computed, ref } from 'vue';
import { UiBadge, UiCodeBlock, UiTabs, fullTime, type TabItem } from '../../ui/index.ts';
import { formatCost, formatDuration, formatTokens } from '../logic/format.ts';
import { messageContent, taggedBlocks } from '../logic/inspect.ts';

type Tab = 'saw' | 'tools' | 'answer' | 'json';

const props = defineProps<{ call: LlmInteraction }>();

const tab = ref<Tab>('saw');
const tabs = computed<TabItem<Tab>[]>(() => [
  { value: 'saw', label: 'What it saw', count: props.call.request.messages.length },
  { value: 'tools', label: 'Tools', count: props.call.request.tools?.length ?? 0 },
  { value: 'answer', label: 'Answer' },
  { value: 'json', label: 'JSON' },
]);
const messages = computed(() => props.call.request.messages.map((m, i) => {
  const text = messageContent(m);
  return { key: i, role: m.role, text, tags: taggedBlocks(text), toolCalls: m.toolCalls ?? [] };
}));
const firstToken = computed(() => (props.call.firstTokenAt === undefined ? undefined : props.call.firstTokenAt - props.call.queuedAt));
const duration = computed(() => (props.call.startedAt === undefined || props.call.endedAt === undefined ? undefined : props.call.endedAt - props.call.startedAt));
const json = computed(() => JSON.stringify(props.call, null, 2));
</script>

<template>
  <div class="call" data-testid="llm-call">
    <dl class="facts">
      <dt>Model</dt><dd><code>{{ call.model }}</code> · {{ call.provider }}</dd>
      <dt>Status</dt><dd><UiBadge :tone="call.status === 'done' ? 'ok' : call.status === 'failed' ? 'danger' : 'accent'">{{ call.status }}</UiBadge></dd>
      <template v-if="call.usage"><dt>Tokens</dt><dd>{{ formatTokens(call.usage.input) }} in · {{ formatTokens(call.usage.output) }} out<span v-if="call.usage.cached"> · {{ formatTokens(call.usage.cached) }} cached</span><span v-if="call.usage.reasoning"> · {{ formatTokens(call.usage.reasoning) }} reasoning</span></dd></template>
      <dt>Cost</dt><dd data-testid="llm-cost">{{ formatCost(call.cost) }}</dd>
      <template v-if="firstToken !== undefined"><dt>First token</dt><dd>{{ formatDuration(firstToken) }}</dd></template>
      <template v-if="duration !== undefined"><dt>Took</dt><dd>{{ formatDuration(duration) }}</dd></template>
      <dt>Queued</dt><dd>{{ fullTime(call.queuedAt) }} · {{ call.priority }}</dd>
      <template v-if="call.error"><dt>Error</dt><dd class="error">{{ call.error }}</dd></template>
    </dl>
    <UiTabs v-model="tab" :tabs="tabs" label="LLM call">
      <template #default="{ value }">
        <ol v-if="value === 'saw'" class="messages" data-testid="llm-messages">
          <li v-for="m in messages" :key="m.key" class="message" :class="m.role">
            <span class="role">{{ m.role }}</span>
            <div v-if="m.tags.length > 0" class="tags">
              <div v-for="(tag, i) in m.tags" :key="i" class="tag"><span class="tag-name">&lt;{{ tag.tag }}&gt;</span> {{ tag.text }}</div>
            </div>
            <pre class="text">{{ m.text }}</pre>
            <pre v-for="tool in m.toolCalls" :key="tool.id" class="tool-call">{{ tool.name }}({{ tool.arguments }})</pre>
          </li>
        </ol>
        <ul v-else-if="value === 'tools'" class="tools">
          <li v-for="tool in call.request.tools ?? []" :key="tool.name">
            <strong>{{ tool.name }}</strong>
            <p v-if="tool.description" class="dim">{{ tool.description }}</p>
          </li>
          <li v-if="(call.request.tools ?? []).length === 0" class="dim">No tools were offered.</li>
        </ul>
        <div v-else-if="value === 'answer'" class="answer">
          <template v-if="call.response">
            <p v-if="call.response.reasoning" class="reasoning">{{ call.response.reasoning }}</p>
            <pre class="text">{{ call.response.content }}</pre>
            <pre v-for="tool in call.response.toolCalls ?? []" :key="tool.id" class="tool-call">{{ tool.name }}({{ tool.arguments }})</pre>
            <p class="dim">Stopped: {{ call.response.finishReason }}</p>
          </template>
          <p v-else class="dim">No answer yet.</p>
        </div>
        <UiCodeBlock v-else :code="json" language="json" :max-height="520" />
      </template>
    </UiTabs>
  </div>
</template>

<style scoped>
.call { display: grid; gap: var(--space-4); min-width: 0; }
.facts { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; font-size: var(--text-sm); }
dt { color: var(--text-faint); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.error { color: var(--danger); }
.messages, .tools { display: grid; gap: var(--space-3); margin: 0; padding: var(--space-3) 0 0; list-style: none; }
.message { display: grid; gap: var(--space-1); padding: var(--space-2) var(--space-3); border-left: 3px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--surface-2); min-width: 0; }
.message.system { border-left-color: var(--accent); }
.message.user { border-left-color: var(--ok); }
.message.tool { border-left-color: var(--warn); }
.role { color: var(--text-faint); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.tags { display: grid; gap: 2px; }
.tag { font-size: var(--text-xs); color: var(--text-dim); overflow-wrap: anywhere; }
.tag-name { font-family: var(--mono); color: var(--accent); }
.text, .tool-call { margin: 0; font-family: var(--mono); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow-y: auto; }
.tool-call { color: var(--warn); }
.reasoning { margin: 0; color: var(--text-dim); font-size: var(--text-sm); white-space: pre-wrap; }
.answer { display: grid; gap: var(--space-2); padding-top: var(--space-3); }
.dim { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
</style>
