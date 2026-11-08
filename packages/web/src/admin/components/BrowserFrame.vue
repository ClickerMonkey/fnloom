<script setup lang="ts">
/**
 * A browser's frame: its filters, the list (skeleton, problem, empty, rows), more rows fetched as the end comes into
 * view (or with the button), and the opened item beside the list on roomy screens or in a sheet otherwise.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import PanelFrame from '../../chat/components/PanelFrame.vue';
import PanelHost from '../../chat/components/PanelHost.vue';
import { COMPACT_QUERY } from '../../state/layout.ts';
import { UiButton, useMediaQuery, type IconName } from '../../ui/index.ts';
import LoadState from './LoadState.vue';

const props = withDefaults(defineProps<{
  loading: boolean;
  loaded: boolean;
  problem: string;
  empty: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  emptyTitle: string;
  emptyBody?: string;
  emptyIcon?: IconName;
  panelTitle?: string;
  panelSubtitle?: string;
  label: string;
}>(), { emptyBody: '', emptyIcon: 'search', panelTitle: '', panelSubtitle: '' });
const panelOpen = defineModel<boolean>('panel', { required: true });
const emit = defineEmits<{ more: []; retry: [] }>();
const slots = defineSlots<{ filters?: () => unknown; default: () => unknown; panel?: () => unknown }>();

const roomy = useMediaQuery('(min-width: 1360px)');
const phone = useMediaQuery(COMPACT_QUERY);
const sentinel = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;

/** The pinned filters' height, so a row brought into view (focus, the opened one) lands below them, not under them. */
const filters = ref<HTMLElement | null>(null);
const filtersHeight = ref(0);
let sizer: ResizeObserver | undefined;
watch(filters, (el) => {
  sizer?.disconnect();
  if (el === null || typeof ResizeObserver === 'undefined') { return; }
  sizer = new ResizeObserver(() => { filtersHeight.value = el.offsetHeight; });
  sizer.observe(el);
});
const frameStyle = computed(() => ({ '--filters-height': `${filtersHeight.value}px` }));

watch(sentinel, (el) => {
  observer?.disconnect();
  if (el === null || typeof IntersectionObserver === 'undefined') { return; }
  observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && props.hasMore && !props.loadingMore) { emit('more'); } }, { rootMargin: '240px' });
  observer.observe(el);
});
onBeforeUnmount(() => { observer?.disconnect(); sizer?.disconnect(); });
</script>

<template>
  <div class="browser" :class="{ split: roomy && panelOpen }" :style="frameStyle">
    <div class="list-side">
      <div v-if="slots.filters" ref="filters" class="filters pinned" role="search" :aria-label="`Filter ${label}`"><slot name="filters" /></div>
      <LoadState :loading="loading" :problem="problem" :ready="loaded" :empty="empty" :empty-icon="emptyIcon" :empty-title="emptyTitle" :empty-body="emptyBody" :lines="8" @retry="emit('retry')">
        <ul class="rows" :aria-label="label"><slot /></ul>
        <div v-if="hasMore" ref="sentinel" class="more">
          <UiButton variant="ghost" :loading="loadingMore" data-testid="more" @click="emit('more')">Show more</UiButton>
        </div>
      </LoadState>
    </div>
    <PanelHost v-model:open="panelOpen" :inline="roomy" :phone="phone" :label="panelTitle || label">
      <PanelFrame :title="panelTitle || label" :subtitle="panelSubtitle" @close="panelOpen = false">
        <slot name="panel" />
      </PanelFrame>
    </PanelHost>
  </div>
</template>

<style scoped>
.browser { display: grid; gap: var(--space-4); min-width: 0; }
.browser.split { grid-template-columns: minmax(0, 1fr) 440px; align-items: start; }
.browser.split :deep([data-testid='chat-panel']) {
  position: sticky; top: calc(var(--pinned-top, 0px) + var(--space-4)); max-height: calc(100dvh - var(--pinned-top, 0px) - 2 * var(--space-4)); overflow: auto;
  border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
}
.list-side { display: grid; gap: var(--space-3); min-width: 0; align-content: start; }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: var(--space-2) var(--space-3); align-items: end; }
.rows { display: grid; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-sm); list-style: none; overflow: hidden; }
.rows > :deep(*) { scroll-margin-top: calc(var(--pinned-top, 0px) + var(--filters-height, 0px) + var(--space-2)); }
.more { display: flex; justify-content: center; }
</style>
