<script setup lang="ts">
/**
 * Beside a per-person system's config (Google Calendar's OAuth client): the redirect address to give the provider,
 * with a copy button, and a link to the page where every person connects their own account once it is set up.
 */
import type { RouteLocationRaw } from 'vue-router';
import { UiBadge, UiCard, UiIcon, UiIconButton } from '../../ui/index.ts';
import { copyText } from '../../ui/clipboard.ts';

const props = defineProps<{
  /** The people's page's title ("Calendar"). */
  title: string;
  /** The address the provider sends people back to (`<hub>/connect/callback`). */
  redirect: string;
  ready: boolean;
  page: RouteLocationRaw;
}>();
const emit = defineEmits<{ copied: [ok: boolean] }>();

async function copy(): Promise<void> {
  emit('copied', await copyText(props.redirect));
}
</script>

<template>
  <UiCard title="People connect their own account" compact data-testid="connect-setup">
    <template #actions><UiBadge :tone="ready ? 'ok' : 'warn'" dot>{{ ready ? 'Ready' : 'Needs its config' }}</UiBadge></template>
    <dl class="facts">
      <div>
        <dt>Redirect address</dt>
        <dd class="redirect"><code data-testid="connect-redirect">{{ redirect }}</code><UiIconButton icon="copy" label="Copy the redirect address" size="sm" @click="copy" /></dd>
      </div>
      <div>
        <dt>Their page</dt>
        <dd><RouterLink :to="page" class="link" data-testid="connect-page-link"><UiIcon name="link" :size="14" />{{ title }}</RouterLink></dd>
      </div>
    </dl>
  </UiCard>
</template>

<style scoped>
.facts { display: grid; gap: var(--space-2); margin: 0; }
.facts > div { display: grid; grid-template-columns: 9rem minmax(0, 1fr); align-items: center; gap: var(--space-3); }
dt { color: var(--text-dim); font-size: var(--text-sm); }
dd { margin: 0; min-width: 0; }
.redirect { display: flex; align-items: center; gap: var(--space-2); }
.redirect code { overflow-wrap: anywhere; font-size: var(--text-sm); }
.link { display: inline-flex; align-items: center; gap: var(--space-1); }
@media (max-width: 480px) { .facts > div { grid-template-columns: minmax(0, 1fr); gap: 2px; } }
</style>
