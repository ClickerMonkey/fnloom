<script setup lang="ts">
/** What a web crawl was, over its pages in the browser: the site, when it ran, how many pages it kept, and a link to the site. */
import { safeHref } from '@harness/sdk';
import { computed } from 'vue';
import { UiIcon, fullTime } from '../../ui/index.ts';
import type { CrawlFolder } from '../logic/crawls.ts';

const props = defineProps<{
  crawl: CrawlFolder;
  /** How many pages it kept, when known. */
  pages?: number | undefined;
}>();

/** The site's address, when the folder's host makes a safe one. */
const site = computed(() => safeHref(`https://${props.crawl.host}`));
</script>

<template>
  <div class="crawl" data-testid="crawl-summary">
    <span class="mark" aria-hidden="true"><UiIcon name="globe" :size="18" /></span>
    <div class="what">
      <span class="title">Crawl of {{ crawl.host }}</span>
      <span class="detail">
        <time :datetime="new Date(crawl.at).toISOString()">{{ fullTime(crawl.at) }}</time>
        <template v-if="pages !== undefined"> · {{ pages.toLocaleString() }} {{ pages === 1 ? 'page' : 'pages' }}</template>
      </span>
    </div>
    <a v-if="site" :href="site" target="_blank" rel="noopener noreferrer" class="site">Open site <UiIcon name="external" :size="14" /></a>
  </div>
</template>

<style scoped>
.crawl { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.mark { display: grid; place-items: center; width: 2rem; height: 2rem; flex: none; border-radius: var(--radius); background: var(--surface-2); color: var(--accent); }
.what { display: grid; flex: 1 1 12rem; min-width: 0; }
.title { font-weight: var(--weight-strong); overflow-wrap: anywhere; }
.detail { color: var(--text-dim); font-size: var(--text-sm); }
.site { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-sm); }
</style>
