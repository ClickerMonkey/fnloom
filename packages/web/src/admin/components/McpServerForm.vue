<script setup lang="ts">
/**
 * An MCP server's settings (`McpServerConfig`): its label and description; how the hub reaches it (a URL over
 * streamable HTTP or SSE, or a command it starts, with arguments, environment values and a folder); how it signs in;
 * which calls wait for approval and whether the server's own read-only marks are trusted; whether its prompts and
 * resources are mirrored; and its limits. The parent checks and saves the draft; problems come by config path.
 */
import type { McpApproval } from '@harness/core';
import { computed } from 'vue';
import { draftFields } from '../state/draft.ts';
import { UiChipInput, UiInput, UiSegmented, UiSwitch, UiTextarea, type SegmentOption } from '../../ui/index.ts';
import { APPROVAL_WORDS, TRANSPORT_WORDS, type McpServerDraft, type McpTransportType } from '../logic/mcp-servers.ts';
import type { PathProblems } from '../../state/problems.ts';
import PairRowsEditor from './PairRowsEditor.vue';
import RemoteAuthFields from './RemoteAuthFields.vue';

withDefaults(defineProps<{ problems?: PathProblems }>(), { problems: () => ({}) });
const draft = defineModel<McpServerDraft>({ required: true });

const TRANSPORTS: readonly SegmentOption<McpTransportType>[] = (['http', 'sse', 'stdio'] as const).map((type) => ({ value: type, label: TRANSPORT_WORDS[type].label }));
const APPROVALS: readonly SegmentOption<McpApproval>[] = (['writes', 'always', 'never'] as const).map((value) => ({ value, label: APPROVAL_WORDS[value].label }));

const field = draftFields(draft);
const label = field('label');
const description = field('description');
const transport = field('transport');
const command = field('command');
const args = field('args');
const env = field('env');
const cwd = field('cwd');
const url = field('url');
const auth = field('auth');
const trusted = field('trusted');
const approval = field('approval');
const prompts = field('prompts');
const resources = field('resources');
const maxTools = field('maxTools');
const timeout = field('timeout');

const approvalAbout = computed(() => APPROVAL_WORDS[draft.value.approval].about);
const readArg = (text: string): string | undefined => (text === '' ? undefined : text);
</script>

<template>
  <div class="form" data-testid="mcp-server-form">
    <UiInput v-model="label" label="Name" placeholder="Linear" required :error="problems['label'] ?? ''" data-testid="server-label" />
    <UiTextarea v-model="description" label="Description" :rows="2" placeholder="What it is for" />

    <div class="group">
      <span class="group-label">Transport</span>
      <UiSegmented v-model="transport" :options="TRANSPORTS" label="Transport" data-testid="server-transport" />
      <p class="hint">{{ TRANSPORT_WORDS[draft.transport].about }}</p>
    </div>
    <UiInput
      v-if="transport !== 'stdio'" v-model="url" label="URL" type="url" placeholder="https://mcp.example.com/mcp" required
      :error="problems['transport.url'] ?? problems['transport'] ?? ''" data-testid="server-url"
    />
    <template v-else>
      <div class="pair">
        <UiInput v-model="command" label="Command" placeholder="npx" required :error="problems['transport.command'] ?? problems['transport'] ?? ''" data-testid="server-command" />
        <UiInput v-model="cwd" label="Folder" placeholder="Where it runs (optional)" />
      </div>
      <UiChipInput v-model="args" label="Arguments" placeholder="-y @modelcontextprotocol/server-github" hint="Enter adds one, in order." :read="readArg" refusal="Type an argument." />
      <PairRowsEditor
        v-model:rows="env" label="Environment" name-placeholder="GITHUB_TOKEN" secret :kept="draft.envKept"
        hint="Credentials for a command go here; the hub seals them." :error="problems['transport.env'] ?? ''" testid="server-env"
        @replace="draft = { ...draft, envKept: false, env: [] }"
      />
    </template>

    <RemoteAuthFields v-if="transport !== 'stdio'" v-model="auth" :problems="problems" />

    <div class="group">
      <span class="group-label">Approval</span>
      <UiSegmented v-model="approval" :options="APPROVALS" label="Approval" data-testid="server-approval" />
      <p class="hint">{{ approvalAbout }}</p>
    </div>
    <div class="switches">
      <UiSwitch v-model="trusted" label="Trust its read-only marks" description="Its own annotations may let reads run without approval." />
      <UiSwitch v-model="prompts" label="Prompts as /commands" description="Each prompt becomes a context item with a command." />
      <UiSwitch v-model="resources" label="Resources" description="Its resources show under its own root." />
    </div>
    <div class="pair">
      <UiInput v-model="maxTools" label="Most tools" type="number" hint="Tools past this are left out." :error="problems['maxTools'] ?? ''" />
      <UiInput v-model="timeout" label="Call timeout (seconds)" type="number" :error="problems['timeout'] ?? ''" />
    </div>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-4); min-width: 0; }
.group { display: grid; gap: var(--space-2); }
.group-label { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.hint { margin: 0; color: var(--text-faint); font-size: var(--text-xs); }
.pair { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); }
.switches { display: grid; gap: var(--space-3); }
</style>
