<script setup lang="ts">
/**
 * Connecting to an MCP: its URL, the Claude Code command and a `.mcp.json` (with the secret when it was just made or
 * rotated here, else a placeholder: the hub never shows a secret twice), and trying it as a client would with a
 * secret, listing the tools it offers.
 */
import type { HubMcpView } from '@harness/core';
import { computed, ref } from 'vue';
import { UiBanner, UiButton, UiCard, UiCodeBlock, UiInput, UiSkeleton, copyText } from '../../ui/index.ts';
import { connectSnippets } from '../logic/mcps.ts';
import type { ProbeResult } from '../probe.ts';

const props = withDefaults(defineProps<{
  mcp: HubMcpView;
  /** The secret shown once on this page, or ''. */
  secret?: string;
  tried?: ProbeResult | undefined;
  trying?: boolean;
  problem?: string;
}>(), { secret: '', tried: undefined, trying: false, problem: '' });
const emit = defineEmits<{ try: [secret: string]; copied: [what: string] }>();

const typed = ref('');
const snippets = computed(() => connectSnippets(props.mcp, window.location.origin, props.secret === '' ? undefined : props.secret));

async function copy(text: string, what: string): Promise<void> {
  if (await copyText(text)) { emit('copied', what); }
}
</script>

<template>
  <div class="connect" data-testid="mcp-connect">
    <UiCard title="Address" :subtitle="mcp.enabled ? 'Streamable HTTP, with the secret as a bearer token.' : 'Turned off: it refuses every call.'">
      <div class="url">
        <code data-testid="mcp-url">{{ mcp.url }}</code>
        <UiButton size="sm" variant="ghost" icon="copy" @click="copy(mcp.url, 'Address')">Copy</UiButton>
      </div>
    </UiCard>
    <UiCard title="Claude Code" subtitle="Run this where the Claude session runs.">
      <UiCodeBlock :code="snippets.claude" language="bash" data-testid="mcp-claude" />
      <UiBanner v-if="secret === ''" tone="neutral">The secret was shown once, when it was made. Rotate it to get a new one.</UiBanner>
    </UiCard>
    <UiCard title=".mcp.json">
      <UiCodeBlock :code="snippets.json" language="json" />
    </UiCard>
    <UiCard title="Try it" subtitle="Connect as a client would and list its tools.">
      <form class="try" @submit.prevent="emit('try', typed)">
        <UiInput v-model="typed" type="password" label="Secret" :placeholder="secret === '' ? 'hmcp_…' : 'The one shown on this page'" autocomplete="off" data-testid="mcp-try-secret" />
        <UiButton type="submit" icon="play" :loading="trying" :disabled="typed.trim() === '' && secret === ''" data-testid="mcp-try">Try it</UiButton>
      </form>
      <UiBanner v-if="problem !== ''" tone="danger">{{ problem }}</UiBanner>
      <UiSkeleton v-if="trying && tried === undefined" shape="lines" :lines="3" />
      <div v-else-if="tried" class="tried" data-testid="mcp-tried">
        <p class="dim">{{ tried.server.name }} {{ tried.server.version }} answered with {{ tried.tools.length }} {{ tried.tools.length === 1 ? 'tool' : 'tools' }}.</p>
        <ul class="tools">
          <li v-for="tool in tried.tools" :key="tool.name"><code>{{ tool.name }}</code><span v-if="tool.description" class="dim"> {{ tool.description }}</span></li>
        </ul>
      </div>
    </UiCard>
  </div>
</template>

<style scoped>
.connect { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); align-items: start; gap: var(--space-4); }
.url { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.url code { min-width: 0; overflow-wrap: anywhere; }
.try { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-2); }
.try > :first-child { flex: 1 1 200px; }
.tried { display: grid; gap: var(--space-2); }
.tools { display: grid; gap: var(--space-1); margin: 0; padding-left: var(--space-4); font-size: var(--text-sm); }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
