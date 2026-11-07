<script setup lang="ts">
/**
 * The resources browser: every resource the hub knows, most recently seen first, searched and narrowed by system
 * (both in the URL). A resource opens beside the list (`?uri=`) in its system's own viewer when it has one, or the
 * default one (markdown rendered, code highlighted); its links open the resource they point at.
 */
import { ResourceUri } from '@harness/core';
import { computed, onMounted, watch } from 'vue';
import AppPage from '../../app/AppPage.vue';
import { useQueryDraft, useQueryText } from '../../app/url.ts';
import ResourceView from '../../chat/components/ResourceView.vue';
import { formatBytes } from '../../chat/logic/format.ts';
import { resourceRenderView } from '../../chat/state/renderers.ts';
import { useStores } from '../../state/stores.ts';
import { UiBadge, UiIcon, UiInput, type IconName } from '../../ui/index.ts';
import { useNow } from '../../ui/now.ts';
import BrowserFrame from '../components/BrowserFrame.vue';
import BrowserRow from '../components/BrowserRow.vue';
import { ResourceFilter } from '@harness/core';
import { filterOf } from '../logic/browsers.ts';

const { admin, chat } = useStores();
const resources = admin.resources;
const now = useNow();
const search = useQueryDraft('q');
const system = useQueryDraft('system');
const opened = useQueryText('uri', { push: true });

const TYPE_ICON = { folder: 'archive', file: 'file', page: 'link', record: 'tree', other: 'dot' } as const satisfies Record<string, IconName>;
const filter = computed(() => filterOf(ResourceFilter, { search: search.value.value, system: system.value.value }));
const items = computed(() => resources.list.items.value);
const read = computed(() => resources.opened.value.value);
const custom = computed(() => resourceRenderView(chat.renderers, read.value));
const panel = computed({ get: () => opened.value !== '', set: (open) => { if (!open) { opened.value = ''; } } });

onMounted(() => { void chat.prepareRenderers(); });
watch(filter, (value) => { void resources.list.load(value); }, { immediate: true });
watch(opened, (uri) => {
  const parsed = ResourceUri.safeParse(uri);
  if (parsed.success) { void resources.open(parsed.data); } else { resources.close(); }
}, { immediate: true });

/** A link inside a resource opens the resource it points at, when it is one the hub can read. */
function navigate(href: string): void {
  if (ResourceUri.safeParse(href).success) { opened.value = href; } else { window.open(href, '_blank', 'noopener'); }
}

</script>

<template>
  <AppPage title="Resources" description="Files, pages and records the systems serve, as the hub has seen them.">
    <BrowserFrame
      v-model:panel="panel" label="Resources" :loading="resources.list.loading.value" :loaded="resources.list.loaded.value" :problem="resources.list.problem.value"
      :empty="items.length === 0" :has-more="resources.list.hasMore.value" :loading-more="resources.list.loadingMore.value"
      empty-icon="file" empty-title="No resources match" :empty-body="filter.search || filter.system ? 'Try other words.' : 'Resources show here as systems serve them.'"
      :panel-title="read?.stat.name ?? 'Resource'" :panel-subtitle="read?.stat.uri ?? ''" @more="resources.list.more()" @retry="resources.list.load()"
    >
      <template #filters>
        <UiInput v-model="search.draft.value" type="search" icon="search" label="Search" placeholder="Name or address" clearable />
        <UiInput v-model="system.draft.value" type="search" label="System" placeholder="Any" clearable />
      </template>
      <BrowserRow
        v-for="item in items" :key="item.uri" :title="item.stat.name" :detail="item.uri" :at="item.seenAt" :now="now"
        :selected="opened === item.uri" :testid="`resource-${item.stat.name}`" @open="opened = item.uri"
      >
        <template #mark><UiIcon :name="TYPE_ICON[item.stat.type]" :size="16" /></template>
        <template #badges>
          <UiBadge>{{ item.system }}</UiBadge>
          <UiBadge v-if="item.stat.format">{{ item.stat.format }}</UiBadge>
          <UiBadge v-if="item.indexedVersion === item.stat.version" tone="ok">Indexed</UiBadge>
        </template>
        <template #figures><span v-if="item.stat.size !== undefined">{{ formatBytes(item.stat.size) }}</span></template>
      </BrowserRow>
      <template #panel>
        <ResourceView
          :read="read" :loading="resources.opened.loading.value" :problem="resources.opened.problem.value" :custom="custom" :navigate="navigate"
          @retry="resources.openedId.value && resources.open(resources.openedId.value)"
        />
      </template>
    </BrowserFrame>
  </AppPage>
</template>
