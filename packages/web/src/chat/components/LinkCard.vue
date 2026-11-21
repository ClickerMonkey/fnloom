<script setup lang="ts">
/**
 * A link a fn added to an answer, as a card: a resource (opens the viewer), a web page, a stored file, or a run. A web
 * address that isn't safe to open (`safeHref`) shows as plain text, not a link.
 */
import type { Link } from '@harness/core';
import { safeHref } from '@harness/sdk';
import { computed } from 'vue';
import { UiIcon, type IconName } from '../../ui/index.ts';
import { formatBytes } from '../logic/format.ts';

const props = defineProps<{ link: Link }>();
const emit = defineEmits<{ open: [link: Link] }>();

/** A web link's address, when it is safe to open. */
const href = computed(() => ('url' in props.link ? safeHref(props.link.url) : undefined));

const look = computed<{ icon: IconName; title: string; where: string }>(() => {
  const link = props.link;
  if ('resource' in link) { return { icon: 'copy', title: link.title ?? link.resource.split('/').at(-1) ?? link.resource, where: link.resource }; }
  if ('url' in link) { return { icon: 'external', title: link.title, where: href.value === undefined ? link.url : new URL(href.value, window.location.href).host }; }
  if ('file' in link) { return { icon: 'copy', title: link.title, where: `${link.file.mime} · ${formatBytes(link.file.size)}` }; }
  return { icon: 'fn', title: link.title, where: 'Run details' };
});
</script>

<template>
  <a v-if="href" class="link-card" :href="href" target="_blank" rel="noopener noreferrer" data-testid="link-card">
    <span class="icon"><UiIcon :name="look.icon" :size="16" /></span>
    <span class="text"><span class="title">{{ look.title }}</span><span class="where">{{ look.where }}</span></span>
  </a>
  <div v-else-if="'url' in link" class="link-card" data-testid="link-card-plain">
    <span class="icon"><UiIcon :name="look.icon" :size="16" /></span>
    <span class="text"><span class="title">{{ look.title }}</span><span class="where">{{ look.where }}</span></span>
  </div>
  <button v-else type="button" class="link-card" data-testid="link-card" @click="emit('open', link)">
    <span class="icon"><UiIcon :name="look.icon" :size="16" /></span>
    <span class="text"><span class="title">{{ look.title }}</span><span class="where">{{ look.where }}</span></span>
    <UiIcon class="go" name="chevron-right" :size="14" />
  </button>
</template>

<style scoped>
.link-card {
  display: flex; align-items: center; gap: var(--space-3); width: 100%; max-width: 420px; min-height: 48px; padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); text-align: left; text-decoration: none;
  transition: border-color var(--fast) var(--ease), background-color var(--fast) var(--ease);
}
.link-card:hover { border-color: var(--border-strong); background: var(--surface-2); }
.link-card:focus-visible { outline: none; box-shadow: var(--ring); }
.icon { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent); }
.text { display: grid; flex: 1; min-width: 0; }
.title { font-weight: var(--weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.where { color: var(--text-faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go { color: var(--text-faint); flex: none; }
</style>
