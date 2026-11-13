<script setup lang="ts">
/**
 * One hub MCP (`/admin/mcps/:id/:tab`): its rules (include and exclude editors, with the live preview of what they
 * expose beside them on wide screens and below on narrow ones; Save once changed), what they expose, how to connect
 * and try it, and its activity (the sessions open on it). The header turns it on and off, edits its settings, rotates
 * its secret (shown once) and deletes it.
 */
import { HubMcpId, type HubMcpInput, type McpSelector } from '@harness/core';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links } from '../../app/routes.ts';
import { useParamChoice } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiEmpty, UiIcon, UiSwitch, UiTabs, fullTime, relativeTime, type TabItem } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import LoadState from '../components/LoadState.vue';
import McpConnect from '../components/McpConnect.vue';
import McpDialog from '../components/McpDialog.vue';
import McpPreview from '../components/McpPreview.vue';
import McpSelectorEditor from '../components/McpSelectorEditor.vue';
import SecretDialog from '../components/SecretDialog.vue';
import { TOOL_MODE_WORDS } from '../logic/mcps.ts';
import { McpTab } from '../sections.ts';

const { admin, session, toasts } = useStores();
const store = admin.mcp;
const route = useRoute();
const router = useRouter();
const now = useNow();
const tab = useParamChoice('tab', McpTab, 'rules');
const id = computed(() => { const parsed = HubMcpId.safeParse(route.params['id']); return parsed.success ? parsed.data : undefined; });
const view = computed(() => store.view.value.value);
const draft = computed(() => store.draft.value);
const editing = ref(false);
const deleting = ref(false);
const rotating = ref(false);
/** The secret dialog is open while a secret made or rotated here hasn't been put away. */
const secretOpen = ref(store.secret.value !== '');
const people = computed(() => admin.actors.options(['user']));

const tabs = computed<readonly TabItem<McpTab>[]>(() => [
  { value: 'rules', label: 'Rules' },
  { value: 'preview', label: 'Exposes', count: store.preview.value.value?.fns.length ?? 0 },
  { value: 'connect', label: 'Connect' },
  { value: 'activity', label: 'Activity', count: view.value?.sessions ?? 0 },
]);

watch(id, (mcp) => { if (mcp !== undefined) { void store.open(mcp); void admin.actors.load(); void admin.systems.load(true); } }, { immediate: true });
watch(tab, (current) => { if (current === 'activity') { void store.loadSessions(); } }, { immediate: true });
useLive(() => { if (tab.value === 'activity') { void store.loadSessions(true); } }, 5_000);
onBeforeUnmount(() => { store.close(); });

function change(side: 'include' | 'exclude', selector: McpSelector): void {
  const rules = draft.value;
  if (rules !== undefined) { store.edit({ ...rules, [side]: selector }); }
}

async function saveRules(): Promise<void> {
  const result = await store.update();
  if (result.ok) { toasts.ok('Rules saved', 'Clients see the change on their next list.'); } else { toasts.error(result.problem); }
}

async function saveSettings(input: HubMcpInput): Promise<void> {
  const { rules: _rules, ...settings } = input;
  const result = await store.update(settings);
  if (!result.ok) { return; }
  editing.value = false;
  toasts.ok('Saved');
}

async function enable(on: boolean): Promise<void> {
  const result = await store.update({ enabled: on });
  if (!result.ok) { toasts.error(result.problem); }
}

async function rotate(): Promise<void> {
  const result = await store.rotateSecret();
  rotating.value = false;
  if (result.ok) { secretOpen.value = true; } else { toasts.error(result.problem); }
}

async function remove(): Promise<void> {
  const ok = await store.delete();
  deleting.value = false;
  if (!ok) { toasts.error(store.remove.problem.value || "Couldn't delete it."); return; }
  toasts.ok(`Deleted ${view.value?.name ?? 'the MCP'}`);
  await router.push(links.mcps());
}
</script>

<template>
  <AppPage :title="view?.name ?? 'MCP'" :description="view?.instructions ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.mcps()" class="crumb" data-testid="back-to-mcps"><UiIcon name="chevron-left" :size="14" />Hub MCP</RouterLink>
    </template>
    <template v-if="view" #actions>
      <UiSwitch :model-value="view.enabled" label="On" data-testid="mcp-enabled" @update:model-value="enable" />
      <UiButton icon="settings" data-testid="mcp-settings" @click="editing = true">Settings</UiButton>
      <UiButton icon="key" data-testid="mcp-rotate" @click="rotating = true">Rotate secret</UiButton>
      <UiButton variant="danger" icon="trash" data-testid="mcp-delete" @click="deleting = true">Delete</UiButton>
    </template>
    <LoadState :loading="store.view.loading.value" :problem="store.view.problem.value" :ready="view !== undefined" :empty="false" :lines="8" @retry="id && store.open(id)">
      <template v-if="view">
        <p class="chips">
          <code class="route">/mcp/{{ view.slug }}</code>
          <UiBadge>{{ TOOL_MODE_WORDS[view.toolMode].label }}</UiBadge>
          <UiBadge>runs as {{ admin.actors.nameOf(view.user) }}</UiBadge>
          <UiBadge v-for="grantee in view.grantees" :key="grantee" tone="accent">tokens for {{ grantee }}</UiBadge>
        </p>
        <UiTabs v-model="tab" :tabs="tabs" label="MCP" />
        <div v-if="tab === 'rules' && draft" class="rules" data-testid="mcp-rules">
          <div class="editors">
            <McpSelectorEditor
              title="Include" about="What it exposes. An empty side exposes nothing." :selector="draft.include" testid="mcp-include"
              @change="change('include', $event)"
            />
            <McpSelectorEditor
              title="Exclude" about="Taken out of what is included." :selector="draft.exclude" tone="exclude" testid="mcp-exclude"
              @change="change('exclude', $event)"
            />
            <div v-if="store.changed.value" class="save-bar" data-testid="rules-changed">
              <span class="dim">The rules changed.</span>
              <UiButton variant="ghost" @click="store.revert()">Undo</UiButton>
              <UiButton variant="primary" :loading="store.save.busy.value" data-testid="rules-save" @click="saveRules">Save rules</UiButton>
            </div>
          </div>
          <McpPreview class="aside" :preview="store.preview.value.value" :loading="store.preview.loading.value" :problem="store.preview.problem.value" />
        </div>
        <McpPreview v-else-if="tab === 'preview'" :preview="store.preview.value.value" :loading="store.preview.loading.value" :problem="store.preview.problem.value" />
        <McpConnect
          v-else-if="tab === 'connect'" :mcp="view" :secret="store.secret.value" :tried="store.tried.value.value" :trying="store.tried.loading.value" :problem="store.tried.problem.value"
          @try="store.tryIt($event)" @copied="toasts.ok(`${$event} copied`)"
        />
        <LoadState
          v-else-if="tab === 'activity'" :loading="store.sessions.loading.value" :problem="store.sessions.problem.value" :ready="store.sessions.value.value !== undefined"
          :empty="(store.sessions.value.value?.length ?? 0) === 0" @retry="store.loadSessions()"
        >
          <template #empty><UiEmpty icon="link" title="No sessions open" :body="`${view.callsToday} calls today. Sessions show here while a client is connected.`" /></template>
          <p class="dim">{{ view.callsToday }} calls today.</p>
          <ul class="sessions" data-testid="mcp-sessions">
            <li v-for="item in store.sessions.value.value ?? []" :key="item.session" class="session">
              <span class="name">{{ item.label }}</span>
              <span class="dim">{{ item.client ? `${item.client.name} ${item.client.version}` : 'Unknown client' }} · since <time :title="fullTime(item.since)">{{ relativeTime(item.since, now) }}</time></span>
              <span class="figures">{{ item.calls }} {{ item.calls === 1 ? 'call' : 'calls' }}<template v-if="item.lastCallAt"> · last {{ relativeTime(item.lastCallAt, now) }}</template></span>
            </li>
          </ul>
        </LoadState>
      </template>
    </LoadState>
    <McpDialog v-model:open="editing" :mcp="view" :people="people" :me="session.user.value?.id" :busy="store.save.busy.value" :problem="store.save.problem.value" @save="saveSettings" />
    <SecretDialog v-model:open="secretOpen" :secret="store.secret.value" :title="`Secret of ${view?.name ?? 'the MCP'}`" @copied="toasts.ok('Secret copied')" />
    <ConfirmDialog
      v-model:open="rotating" title="Rotate the secret?" confirm="Rotate" :busy="store.rotate.busy.value"
      body="A new secret is made and shown once. The old one stops working and every open session ends." @confirm="rotate"
    />
    <ConfirmDialog
      v-model:open="deleting" :title="`Delete ${view?.name ?? 'this MCP'}?`" confirm="Delete" :busy="store.remove.busy.value"
      body="Its route and secret stop working at once. Runs it made stay in the runs browser." @confirm="remove"
    />
  </AppPage>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; }
.route { color: var(--text-dim); font-size: var(--text-sm); }
.rules { display: grid; gap: var(--space-4); align-items: start; }
.editors { display: grid; gap: var(--space-4); min-width: 0; }
@media (min-width: 1100px) {
  .rules { grid-template-columns: minmax(0, 1fr) minmax(280px, 380px); }
  .aside { position: sticky; top: calc(var(--pinned-top, 0px) + var(--space-4)); }
}
.save-bar {
  position: sticky; bottom: var(--space-3); display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2);
  padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-md);
}
.save-bar .dim { margin-right: auto; }
.dim { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.sessions { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); list-style: none; }
.session { display: grid; gap: 2px; padding: var(--space-3) var(--space-4); }
.session + .session { border-top: 1px solid var(--border); }
.name { font-weight: var(--weight-medium); }
.figures { color: var(--text-faint); font-size: var(--text-xs); }
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
</style>
