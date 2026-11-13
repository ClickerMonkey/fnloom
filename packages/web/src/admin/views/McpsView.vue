<script setup lang="ts">
/**
 * The hub MCPs: each with its route, whether it is on, how its tools are offered, the sessions open on it now and its
 * calls today; each opens its page. "New MCP" (`?create=1`) makes one, then opens it with its secret shown once.
 */
import type { HubMcpInput } from '@harness/core';
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppPage from '../../app/AppPage.vue';
import { useLive } from '../../app/live.ts';
import { links, ROUTES } from '../../app/routes.ts';
import { useRouteQuery } from '../../app/url.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiButton, UiEmpty, UiIcon } from '../../ui/index.ts';
import LoadState from '../components/LoadState.vue';
import McpDialog from '../components/McpDialog.vue';
import { selectorSize, TOOL_MODE_WORDS } from '../logic/mcps.ts';

const { admin, session } = useStores();
const mcps = admin.mcps;
const router = useRouter();
const query = useRouteQuery(ROUTES.mcps);
const create = query.text('create', { push: true });
const creating = computed({ get: () => create.value === '1', set: (isOpen) => { create.value = isOpen ? '1' : ''; } });
const list = computed(() => mcps.list.value.value ?? []);
const people = computed(() => admin.actors.options(['user']));

onMounted(() => { void mcps.load(mcps.list.value.value !== undefined); void admin.actors.load(); });
useLive(() => { void mcps.load(true); }, 10_000);

async function make(input: HubMcpInput): Promise<void> {
  const result = await mcps.make(input);
  if (!result.ok) { return; }
  // its page opens with the secret dialog, which says all a toast would
  await admin.mcp.open(result.value.mcp.id, result.value.secret);
  await router.replace(links.mcp(result.value.mcp.id));
}
</script>

<template>
  <AppPage title="Hub MCP" description="MCP endpoints into the hub, each with its own route, secret and rules over what it exposes.">
    <template #actions>
      <UiButton variant="primary" icon="plus" data-testid="new-mcp" @click="creating = true">New MCP</UiButton>
    </template>
    <LoadState :loading="mcps.list.loading.value" :problem="mcps.list.problem.value" :ready="mcps.list.value.value !== undefined" :empty="list.length === 0" @retry="mcps.load()">
      <template #empty>
        <UiEmpty icon="link" title="No hub MCP endpoints yet" body="Make one to give an MCP client (a Claude session, say) a way into the hub, exposing only what you choose.">
          <template #actions><UiButton variant="primary" icon="plus" @click="creating = true">New MCP</UiButton></template>
        </UiEmpty>
      </template>
      <ul class="mcps" data-testid="mcps">
        <li v-for="mcp in list" :key="mcp.id" class="mcp" :data-mcp="mcp.slug">
          <RouterLink class="open" :to="links.mcp(mcp.id)" data-testid="mcp-row">
            <span class="mark" aria-hidden="true"><UiIcon name="link" :size="16" /></span>
            <span class="main">
              <span class="top">
                <span class="name">{{ mcp.name }}</span>
                <UiBadge :tone="mcp.enabled ? 'ok' : 'neutral'" dot>{{ mcp.enabled ? 'On' : 'Off' }}</UiBadge>
                <UiBadge>{{ TOOL_MODE_WORDS[mcp.toolMode].label }}</UiBadge>
              </span>
              <code class="route">/mcp/{{ mcp.slug }}</code>
              <span class="detail">{{ selectorSize(mcp.rules.include) }} included · {{ selectorSize(mcp.rules.exclude) }} excluded</span>
            </span>
            <span class="figures">
              <span><strong>{{ mcp.sessions }}</strong> {{ mcp.sessions === 1 ? 'session' : 'sessions' }} now</span>
              <span><strong>{{ mcp.callsToday }}</strong> {{ mcp.callsToday === 1 ? 'call' : 'calls' }} today</span>
            </span>
          </RouterLink>
        </li>
      </ul>
    </LoadState>
    <McpDialog v-model:open="creating" :people="people" :me="session.user.value?.id" :busy="mcps.create.busy.value" :problem="mcps.create.problem.value" @save="make" />
  </AppPage>
</template>

<style scoped>
.mcps { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.mcp + .mcp { border-top: 1px solid var(--border); }
.open { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3) var(--space-4); padding: var(--space-3) var(--space-4); color: var(--text); text-decoration: none; }
.open:hover { background: var(--surface-2); text-decoration: none; }
.open:focus-visible { outline: none; box-shadow: inset var(--ring); }
.mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius); background: var(--surface-2); color: var(--text-dim); }
.main { display: grid; gap: 2px; min-width: 0; }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
.name { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
.route { color: var(--text-dim); font-size: var(--text-xs); }
.detail { color: var(--text-faint); font-size: var(--text-xs); }
.figures { display: grid; justify-items: end; gap: 2px; color: var(--text-dim); font-size: var(--text-sm); white-space: nowrap; }
@media (max-width: 559.98px) {
  .open { grid-template-columns: auto minmax(0, 1fr); }
  .figures { grid-column: 2; justify-items: start; }
}
</style>
