<script setup lang="ts">
/**
 * One MCP server (`/admin/mcp-servers/:instance`), its tab in the URL: the overview (its state with its server and
 * why, what the server said about itself, where it is and how it signs in, what it mirrors, with links to its
 * resources, its instance and its sign-ins page when people sign in to it), its tools (the fns it mirrors, the
 * loosely mapped ones marked), its prompts (context items with `/commands`) and its settings (saved as the instance's
 * config; kept secrets stay unless replaced). Removing it removes the instance.
 */
import { InstanceName, connectFlowOf, mcpRootOf } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import type { PathProblems } from '../../state/problems.ts';
import { useStores } from '../../state/stores.ts';
import { UiBanner, UiButton, UiCard, UiIcon, UiTabs, fullTime, relativeTime, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import FactList from '../components/FactList.vue';
import type { Fact } from '../logic/service-views.ts';
import FnList from '../components/FnList.vue';
import LoadState from '../components/LoadState.vue';
import McpServerForm from '../components/McpServerForm.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { MCP, commandText, countsText, isDegraded, mcpServerConfig, mcpServerDraft, readMcpServer, serverLook, transportText, TRANSPORT_WORDS, APPROVAL_WORDS } from '../logic/mcp-servers.ts';
import { authSummary } from '../logic/remote-config.ts';
import { McpServerTab } from '../sections.ts';

const { admin, toasts } = useStores();
const store = admin.mcpServers;
const fleet = store.fleet;
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', McpServerTab, 'overview');
const instance = computed(() => { const read = InstanceName.safeParse(route.params['instance']); return read.success ? read.data : undefined; });
const view = computed(() => (instance.value === undefined ? undefined : fleet.find(instance.value)));
const config = computed(() => readMcpServer(view.value?.config?.value));
const read = computed(() => (instance.value === undefined ? undefined : store.statuses.value.get(instance.value)));
const status = computed(() => (read.value !== undefined && 'status' in read.value ? read.value.status : undefined));
const look = computed(() => (view.value === undefined ? undefined : serverLook(view.value.status, read.value)));
const title = computed(() => config.value?.label ?? instance.value ?? 'MCP server');
const tools = computed(() => store.tools.value.value ?? []);
const prompts = computed(() => store.prompts.value.value ?? []);
const degraded = computed(() => tools.value.filter((fn) => instance.value !== undefined && isDegraded(status.value, instance.value, fn.name)));
const signIn = computed(() => (config.value === undefined || config.value.transport.type === 'stdio' ? undefined : connectFlowOf(config.value.auth)));

const tabs = computed<readonly TabItem<McpServerTab>[]>(() => [
  { value: 'overview', label: 'Overview' },
  { value: 'tools', label: 'Tools', count: tools.value.length },
  { value: 'prompts', label: 'Prompts', count: prompts.value.length },
  { value: 'settings', label: 'Settings' },
]);

const facts = computed<readonly Fact[]>(() => {
  const c = config.value;
  const s = status.value;
  const list: Fact[] = [];
  if (s?.server !== undefined) { list.push({ label: 'Server', value: `${s.server.name} ${s.server.version}`, title: `Protocol ${s.server.protocol}` }); }
  if (c !== undefined) {
    list.push({ label: TRANSPORT_WORDS[c.transport.type].label, value: transportText(c), code: true });
    if (c.transport.type !== 'stdio') { list.push({ label: 'Sign-in', value: authSummary(c.auth) }); }
    list.push({ label: 'Approval', value: `${APPROVAL_WORDS[c.approval].label}${c.trusted ? ', read-only marks trusted' : ''}` });
  }
  if (s !== undefined) {
    list.push({ label: 'Mirrors', value: countsText(s) });
    list.push({ label: 'Checked', value: relativeTime(s.checkedAt, now.value), title: fullTime(s.checkedAt) });
  }
  if (instance.value !== undefined) { list.push({ label: 'Instance', value: instance.value, code: true }); }
  return list;
});

// the settings tab's draft: the saved config until changed
const draft = ref(mcpServerDraft());
const problems = ref<PathProblems>({});
const hubProblems = ref<readonly string[]>([]);
const removing = ref(false);
watch(() => view.value?.config?.version, () => { draft.value = mcpServerDraft(view.value?.config?.value); problems.value = {}; }, { immediate: true });
watch(instance, (name) => { if (name !== undefined) { void store.show(name); } }, { immediate: true });
onBeforeUnmount(() => { store.close(); });

async function save(): Promise<void> {
  const name = instance.value;
  const checked = mcpServerConfig(draft.value);
  problems.value = checked.ok ? {} : checked.problems;
  if (!checked.ok || name === undefined) { return; }
  const result = await fleet.configure(name, checked.config);
  hubProblems.value = result.ok ? [] : result.problems;
  if (!result.ok) { return; }
  toasts.ok('Settings saved', 'It reconnects with them.');
  void store.readStatus(name);
}

async function remove(): Promise<void> {
  const name = instance.value;
  if (name === undefined) { return; }
  const ok = await fleet.remove(name);
  removing.value = false;
  if (!ok) { toasts.error(fleet.removing.problem.value || `Couldn't remove ${title.value}.`); return; }
  toasts.ok(`Removed ${title.value}`, 'Its fns, prompts and resources are gone.');
  await router.push(links.mcpServers());
}

</script>

<template>
  <AppPage :title="title" :description="config?.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.mcpServers()" class="crumb" data-testid="back-to-servers"><UiIcon name="chevron-left" :size="14" />MCP servers</RouterLink>
    </template>
    <template #actions>
      <UiButton v-if="instance" icon="refresh" variant="ghost" data-testid="server-refresh" @click="store.readStatus(instance)">Check</UiButton>
      <UiButton icon="trash" variant="ghost" data-testid="server-remove" @click="removing = true">Remove</UiButton>
    </template>
    <LoadState
      :loading="fleet.list.loading.value" :problem="fleet.list.problem.value" :ready="fleet.list.value.value !== undefined" :empty="view === undefined"
      empty-icon="braces" empty-title="No such MCP server" empty-body="It may have been removed." :lines="8" @retry="instance && store.show(instance)"
    >
      <template v-if="view && instance">
        <div class="status-row">
          <StatusBadge v-if="look" :look="look" />
        </div>
        <UiTabs v-model="tab" :tabs="tabs" label="MCP server" />

        <template v-if="tab === 'overview'">
          <UiBanner v-if="status?.state === 'needs-auth'" tone="warn" data-testid="server-needs-auth">
            It needs a sign-in before its tools can be used.
            <template #actions><UiButton size="sm" @click="router.push(links.connect(MCP))">Sign in</UiButton></template>
          </UiBanner>
          <UiBanner v-else-if="status?.problem" tone="danger" data-testid="server-problem">{{ status.problem }}</UiBanner>
          <UiBanner v-else-if="read && 'problem' in read" tone="warn" data-testid="server-status-problem">{{ read.problem }}</UiBanner>
          <UiCard compact>
            <FactList :facts="facts" testid="server-facts" />
            <p v-if="status?.server?.instructions" class="instructions">{{ status.server.instructions }}</p>
          </UiCard>
          <div class="links">
            <RouterLink v-if="(status?.resources ?? 0) > 0" :to="links.resources({ under: mcpRootOf(instance) })"><UiIcon name="layers" :size="14" />Its resources</RouterLink>
            <RouterLink v-if="signIn !== undefined" :to="links.connect(MCP)" data-testid="server-connections"><UiIcon name="key" :size="14" />Sign-ins</RouterLink>
            <RouterLink :to="links.instance(MCP, instance)"><UiIcon name="server" :size="14" />Its instance</RouterLink>
          </div>
          <p v-if="(status?.leftOut ?? 0) > 0" class="dim">{{ status?.leftOut }} tools were left out past the most tools setting.</p>
        </template>

        <template v-else-if="tab === 'tools'">
          <UiBanner v-if="degraded.length > 0" tone="warn" data-testid="server-degraded">
            {{ degraded.length === 1 ? 'One tool takes' : `${degraded.length} tools take` }} any JSON: the server's schema did not map cleanly, so the server checks the args.
          </UiBanner>
          <LoadState :loading="store.tools.loading.value" :problem="store.tools.problem.value" :ready="store.tools.value.value !== undefined" :empty="tools.length === 0" empty-icon="fn" empty-title="No tools" empty-body="It has not listed any tools yet." @retry="store.show(instance)">
            <FnList :fns="tools" :now="now" :runs-of="links.fnRuns" />
          </LoadState>
        </template>

        <template v-else-if="tab === 'prompts'">
          <LoadState :loading="store.prompts.loading.value" :problem="store.prompts.problem.value" :ready="store.prompts.value.value !== undefined" :empty="prompts.length === 0" empty-icon="book" empty-title="No prompts" :empty-body="config?.prompts === false ? 'Mirroring prompts is off in its settings.' : 'It has no prompts.'" @retry="store.show(instance)">
            <ul class="list" data-testid="server-prompts">
              <li v-for="item in prompts" :key="item.name">
                <RouterLink class="row" :to="links.contextItem(item.name)">
                  <code class="command">{{ commandText(item) ?? item.name }}</code>
                  <span class="about">{{ item.decl.title ?? item.decl.description }}</span>
                </RouterLink>
              </li>
            </ul>
          </LoadState>
        </template>

        <form v-else class="settings" novalidate data-testid="server-settings" @submit.prevent="save">
          <UiCard compact>
            <McpServerForm v-model="draft" :problems="problems" />
          </UiCard>
          <UiBanner v-for="problem in hubProblems" :key="problem" tone="danger">{{ problem }}</UiBanner>
          <div class="save">
            <UiButton variant="ghost" @click="draft = mcpServerDraft(view.config?.value)">Revert</UiButton>
            <UiButton type="submit" variant="primary" :loading="fleet.saving.busy.value" data-testid="server-save">Save</UiButton>
          </div>
        </form>
      </template>
    </LoadState>
    <ConfirmDialog
      v-model:open="removing" :title="`Remove ${title}?`" body="Its fns, prompts and resources leave the hub, and its settings and connections are deleted."
      confirm="Remove" :busy="fleet.removing.busy.value" @confirm="remove"
    />
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
.status-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.dim { color: var(--text-dim); font-size: var(--text-sm); }
.instructions { margin: var(--space-3) 0 0; padding-top: var(--space-3); border-top: 1px solid var(--border); color: var(--text-dim); font-size: var(--text-sm); white-space: pre-wrap; }
.links { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: var(--text-sm); }
.links a { display: inline-flex; align-items: center; gap: var(--space-1); }
.list { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; overflow: hidden; }
.list > li + li { border-top: 1px solid var(--border); }
.row { display: grid; grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr); gap: var(--space-3); align-items: baseline; padding: var(--space-2) var(--space-4); color: var(--text); text-decoration: none; }
.row:hover { background: var(--surface-2); text-decoration: none; }
.command { overflow-wrap: anywhere; }
.about { color: var(--text-dim); font-size: var(--text-sm); }
.settings { display: grid; gap: var(--space-4); max-width: 48rem; }
.save { display: flex; justify-content: flex-end; gap: var(--space-2); }
@media (max-width: 479.98px) {
  .row { grid-template-columns: minmax(0, 1fr); }
}
</style>
