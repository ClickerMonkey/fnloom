<script setup lang="ts">
/**
 * One context item (`/context/:system/:local`): what it is (origin, system, `/command`, the agents it is always given
 * to, tags, size in tokens, weight, when it changed), its text, and its links both ways, grouped by relation. A person
 * adds a link (`?link=1`) and removes links they drew; a memory is edited (`?edit=1`, written anew) or forgotten.
 * Live: a change to this item or one it links with reloads it.
 */
import AccessControl from '../components/access/AccessControl.vue';
import { QualifiedName, type ContextLink, type LinkTarget } from '@harness/core';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppPage from '../app/AppPage.vue';
import { links, ROUTES } from '../app/routes.ts';
import { useRouteQuery } from '../app/url.ts';
import ConfirmDialog from '../admin/components/ConfirmDialog.vue';
import LoadState from '../admin/components/LoadState.vue';
import LinkDialog from '../context/components/LinkDialog.vue';
import LinkGroups from '../context/components/LinkGroups.vue';
import MemoryDialog from '../context/components/MemoryDialog.vue';
import { linkKey, ORIGIN_WORDS, originOf, scopeText, sizeText, type LinkDraft, type MemoryDraft } from '../context/logic/context.ts';
import { targetRoute } from '../context/logic/targets.ts';
import { useStores } from '../state/stores.ts';
import { fullTime, relativeTime, UiBadge, UiBanner, UiButton, UiCard, UiIcon, UiMarkdown } from '../ui/index.ts';
import { useNow } from '../ui/now.ts';

const { context, session, toasts, chat } = useStores();
const item = context.item;
const route = useRoute();
const router = useRouter();
const now = useNow();
const query = useRouteQuery(ROUTES.contextItem);
const linkOpen = query.text('link', { push: true });
const editOpen = query.text('edit', { push: true });
const linking = computed({ get: () => linkOpen.value === '1', set: (isOpen) => { linkOpen.value = isOpen ? '1' : ''; } });
const editing = computed({ get: () => editOpen.value === '1', set: (isOpen) => { editOpen.value = isOpen ? '1' : ''; } });
const forgetting = ref(false);
const removing = ref('');

const name = computed(() => {
  const parsed = QualifiedName.safeParse(`${String(route.params['system'])}/${String(route.params['local'])}`);
  return parsed.success ? parsed.data : undefined;
});
const view = computed(() => item.view.value.value);
const record = computed(() => view.value?.record);
const origin = computed(() => (record.value === undefined ? undefined : ORIGIN_WORDS[originOf(record.value)]));
const memory = computed(() => (record.value?.origin?.type === 'memory' ? record.value.origin : undefined));
const fromResource = computed(() => (record.value?.origin?.type === 'resource' ? record.value.origin : undefined));
const admin = computed(() => session.user.value?.role === 'admin');
const routeOf = (target: LinkTarget) => targetRoute(target, admin.value);
const navigate = (href: string): void => { void router.push(href); };

onMounted(() => { void chat.access.load(); });
watch(name, (next) => { if (next !== undefined) { void item.open(next); } }, { immediate: true });
context.follow();
onBeforeUnmount(() => { item.close(); });

async function addLink(draft: LinkDraft): Promise<void> {
  const result = await item.addLink(draft);
  if (result.ok) { linking.value = false; toasts.ok('Link added'); }
}

async function removeLink(link: ContextLink): Promise<void> {
  removing.value = linkKey(link);
  const result = await item.removeLink(link);
  removing.value = '';
  if (result.ok) { toasts.ok('Link removed'); } else { toasts.error("Couldn't remove that link", result.problem); }
}

async function forget(): Promise<void> {
  const result = await item.forget();
  forgetting.value = false;
  if (result.ok) { toasts.ok('Forgotten', 'It is left out of every selection and search.'); } else { toasts.error("Couldn't forget it", result.problem); }
}

async function save(draft: MemoryDraft): Promise<void> {
  const result = await item.edit(draft);
  if (!result.ok) { return; }
  toasts.ok('Memory saved');
  await router.replace(links.contextItem(result.value));
}
</script>

<template>
  <AppPage :title="name ?? 'Context'" :description="record?.decl.description ?? ''" keep-title>
    <template #crumb>
      <RouterLink :to="links.context()" class="crumb" data-testid="back-to-context"><UiIcon name="chevron-left" :size="14" />Context</RouterLink>
    </template>
    <template v-if="record" #actions>
      <UiButton v-if="memory && record.disabled !== true" icon="edit" data-testid="memory-edit" @click="editing = true">Edit</UiButton>
      <UiButton v-if="memory && record.disabled !== true" icon="forget" data-testid="memory-forget" @click="forgetting = true">Forget</UiButton>
      <UiButton variant="primary" icon="link" data-testid="add-link" @click="linking = true">Add link</UiButton>
    </template>
    <LoadState :loading="item.view.loading.value" :problem="item.view.problem.value" :ready="view !== undefined" :empty="false" :lines="6" @retry="name && item.open(name)">
      <div v-if="view && record && origin" class="layout" data-testid="context-item" :data-context="record.name">
        <div class="main">
          <UiBanner v-if="record.disabled === true" icon="forget" data-testid="context-forgotten">Forgotten: it is left out of every selection and search.</UiBanner>
          <UiBanner v-else-if="record.stale" tone="warn" icon="warning">The resource it was made from has changed since; make it again to bring it up to date.</UiBanner>
          <UiCard title="About" compact>
            <dl class="facts" data-testid="context-facts">
              <div><dt>Origin</dt><dd><UiIcon :name="origin.icon" :size="14" /> {{ origin.label }}</dd></div>
              <div><dt>System</dt><dd><code>{{ record.system }}</code></dd></div>
              <div v-if="memory"><dt>For</dt><dd>{{ scopeText(memory.scope) }}</dd></div>
              <div v-if="fromResource"><dt>Made from</dt><dd><RouterLink :to="links.resources({ uri: fromResource.uri })" class="uri">{{ fromResource.uri }}</RouterLink><template v-if="fromResource.section"> § {{ fromResource.section }}</template></dd></div>
              <div v-if="fromResource"><dt>Text</dt><dd>{{ fromResource.copy === 'live' ? 'Live: read when loaded' : 'A snapshot' }}</dd></div>
              <div v-if="record.decl.command"><dt>Command</dt><dd><code>/{{ record.decl.command.name }}</code></dd></div>
              <div v-if="record.decl.alwaysFor.length > 0"><dt>Always given to</dt><dd class="chips"><code v-for="agent in record.decl.alwaysFor" :key="agent">{{ agent }}</code></dd></div>
              <div v-if="record.tokens"><dt>Size</dt><dd>{{ sizeText(record) }}<template v-if="record.decl.content !== undefined || record.tokens.full > 0">, {{ record.tokens.summary.toLocaleString() }} as a summary</template></dd></div>
              <div><dt>Weight</dt><dd>{{ (record.decl.weight ?? 1).toFixed(2) }}</dd></div>
              <div v-if="record.decl.tags.length > 0"><dt>Tags</dt><dd class="chips"><UiBadge v-for="tag in record.decl.tags" :key="tag">{{ tag }}</UiBadge></dd></div>
              <div><dt>Changed</dt><dd><time :datetime="new Date(record.updatedAt).toISOString()" :title="fullTime(record.updatedAt)">{{ relativeTime(record.updatedAt, now) }}</time></dd></div>
            </dl>
          </UiCard>
          <AccessControl :target="{ kind: 'context', context: record.name }" compact />
          <UiCard title="Text" compact>
            <div v-if="view.text !== undefined && view.text !== ''" class="text" data-testid="context-text"><UiMarkdown :source="view.text" :navigate="navigate" /></div>
            <p v-else class="none">Its system writes this text when it is loaded.</p>
          </UiCard>
        </div>
        <div class="side">
          <UiCard :title="`Links out · ${view.links.length}`" subtitle="What this item links to." compact data-testid="links-out">
            <template #actions><UiButton size="sm" variant="ghost" icon="plus" @click="linking = true">Add</UiButton></template>
            <LinkGroups :links="view.links" direction="out" :route-of="routeOf" :removing="removing" empty="It links to nothing yet." @remove="removeLink" />
          </UiCard>
          <UiCard :title="`Links in · ${view.backlinks.length}`" subtitle="What links to this item." compact data-testid="links-in">
            <LinkGroups :links="view.backlinks" direction="in" :route-of="routeOf" empty="Nothing links here yet." />
          </UiCard>
        </div>
      </div>
    </LoadState>
    <LinkDialog v-if="name" v-model:open="linking" :from="name" :busy="item.linking.busy.value" :problem="item.linking.problem.value" @save="addLink" />
    <MemoryDialog v-model:open="editing" :multi-user="chat.access.multiUser.value" :memory="record" :busy="item.saving.busy.value" :problem="item.saving.problem.value" @save="save" />
    <ConfirmDialog
      v-model:open="forgetting" title="Forget this memory?" body="It is turned off and left out of every selection and search. Its record stays, so the runs that used it still say so."
      confirm="Forget" :busy="item.forgetting.busy.value" @confirm="forget"
    />
  </AppPage>
</template>

<style scoped>
.crumb { display: inline-flex; align-items: center; gap: 2px; margin-left: -2px; color: var(--text-dim); font-weight: var(--weight-medium); text-decoration: none; }
.crumb:hover { color: var(--accent); }
.layout { display: grid; gap: var(--space-4); align-items: start; }
.main, .side { display: grid; gap: var(--space-4); min-width: 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 140px), 1fr)); gap: var(--space-3) var(--space-5); margin: 0; }
.facts > div { display: grid; align-content: start; gap: 2px; min-width: 0; }
.facts dt { color: var(--text-faint); font-size: var(--text-xs); }
.facts dd { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1); margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.chips { gap: var(--space-1); }
.uri { font-family: var(--mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
.text { max-height: 60vh; overflow: auto; }
.none { margin: 0; color: var(--text-faint); font-size: var(--text-sm); }
@media (min-width: 1100px) {
  .layout { grid-template-columns: minmax(0, 1fr) minmax(360px, 440px); }
}
</style>
