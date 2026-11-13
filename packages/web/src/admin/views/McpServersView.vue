<script setup lang="ts">
/**
 * The MCP servers the hub connects to (`/admin/mcp-servers`), each an instance of the bundled `mcp` system: its name,
 * where it is (a URL or a command), how it signs in, its state with its server, what it mirrors (tools, prompts,
 * resources) and how many tools mapped only loosely; each opens its page. "Add MCP server" (`?add=1`) adds one: the
 * hub installs, pairs, configures and starts it.
 */
import { InstanceName } from '@harness/core';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import type { PathProblems } from '../../state/problems.ts';
import { useStores } from '../../state/stores.ts';
import { UiButton, UiEmpty } from '../../ui/index.ts';
import AddServiceDialog from '../components/AddServiceDialog.vue';
import LoadState from '../components/LoadState.vue';
import McpServerForm from '../components/McpServerForm.vue';
import ServiceRows from '../components/ServiceRows.vue';
import type { ServiceRow } from '../logic/service-views.ts';
import { countsText, mcpServerConfig, mcpServerDraft, readMcpServer, serverLook, transportText } from '../logic/mcp-servers.ts';
import { authSummary } from '../logic/remote-config.ts';

const { admin, toasts } = useStores();
const store = admin.mcpServers;
const fleet = store.fleet;
const router = useRouter();
const query = useRouteQuery(ROUTES.mcpServers);
const add = query.text('add', { push: true });
const adding = computed({ get: () => add.value === '1', set: (isOpen) => { add.value = isOpen ? '1' : ''; } });

const draft = ref(mcpServerDraft());
const instance = ref('');
const problems = ref<PathProblems>({});
const nameError = ref('');
watch(adding, (isOpen) => { if (isOpen) { draft.value = mcpServerDraft(); instance.value = ''; problems.value = {}; nameError.value = ''; } });

/** Each server as its row shows it. */
const rows = computed(() => (fleet.list.value.value ?? []).map((view): ServiceRow => {
  const config = readMcpServer(view.config?.value);
  const read = store.statuses.value.get(view.instance);
  const status = read !== undefined && 'status' in read ? read.status : undefined;
  const loose = status?.degraded.length ?? 0;
  return {
    key: view.instance, to: links.mcpServer(view.instance), label: config?.label ?? view.instance, look: serverLook(view.status, read),
    where: config === undefined ? 'Not set up' : transportText(config),
    detail: [view.instance, config === undefined ? '' : authSummary(config.auth)].filter((part) => part !== '').join(' · '),
    warning: loose === 0 ? undefined : `${loose} loose`, figures: status === undefined ? undefined : countsText(status),
  };
}));

onMounted(() => { void store.load(fleet.list.value.value !== undefined); });
useLive(() => { void store.load(true); }, 15_000);

async function save(): Promise<void> {
  const checked = mcpServerConfig(draft.value);
  const name = InstanceName.safeParse(instance.value);
  problems.value = checked.ok ? {} : checked.problems;
  nameError.value = name.success ? '' : 'invalid';
  if (!checked.ok || !name.success) { return; }
  const description = draft.value.description.trim();
  const added = await fleet.add(name.data, checked.config, description === '' ? undefined : description);
  if (!added.ok) { return; }
  toasts.ok(`Added ${draft.value.label.trim()}`, 'It connects in a moment.');
  await router.replace(links.mcpServer(added.value.instance));
}
</script>

<template>
  <AppPage title="MCP servers" description="MCP servers the hub connects to: their tools become fns, their prompts /commands, their resources browsable.">
    <template #actions>
      <UiButton variant="primary" icon="plus" data-testid="add-mcp-server" @click="adding = true">Add MCP server</UiButton>
    </template>
    <LoadState :loading="fleet.list.loading.value" :problem="fleet.list.problem.value" :ready="fleet.list.value.value !== undefined" :empty="rows.length === 0" @retry="store.load()">
      <template #empty>
        <UiEmpty icon="braces" title="No MCP servers yet" body="Add one by its URL or the command that starts it; its tools join the chat with approvals and visibility like any fn.">
          <template #actions><UiButton variant="primary" icon="plus" @click="adding = true">Add MCP server</UiButton></template>
        </UiEmpty>
      </template>
      <ServiceRows :rows="rows" icon="braces" testid="mcp-servers" />
    </LoadState>
    <AddServiceDialog
      v-model:open="adding" v-model:instance="instance" title="Add MCP server" description="The hub connects to it and mirrors its tools, prompts and resources."
      :label="draft.label" name-hint="Its fns are named after it (linear_create_issue); it can't change later." :name-error="nameError"
      :busy="fleet.adding.busy.value" :problem="fleet.adding.problem.value" @save="save"
    >
      <McpServerForm v-model="draft" :problems="problems" />
    </AddServiceDialog>
  </AppPage>
</template>
