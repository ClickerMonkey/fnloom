<script setup lang="ts">
/**
 * One schedule as the chat's results draw it (`schedule/add`, `change`, each of `list`'s items): its name and the fn it
 * runs, when it runs in words, its next runs, whether it is paused, when it notifies, how its last run went, the next
 * run's args, and links to its page and history. A plain click on a link moves the app in a chat (`CHAT_HOST`);
 * elsewhere the links are plain. It draws with the app's own badge and fn pill (`APP_COMPONENTS`).
 */
import { APP_COMPONENTS, CHAT_HOST } from '@harness/sdk';
import { inject } from 'vue';
import type { ScheduleCard } from './results.ts';

defineProps<{ card: ScheduleCard }>();

const chat = inject(CHAT_HOST, undefined);
const parts = inject(APP_COMPONENTS, undefined);

/** A plain click moves the chat's app; one that opens a new tab keeps the link's own way. */
function open(event: MouseEvent, href: string): void {
  if (chat === undefined || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) { return; }
  event.preventDefault();
  chat.navigate(href);
}
</script>

<template>
  <article class="schedule" data-testid="schedule-card" :data-schedule="card.name">
    <header class="head">
      <a class="title" :href="card.href" data-testid="schedule-card-link" @click="open($event, card.href)">{{ card.title }}</a>
      <component :is="parts.Badge" v-if="parts && card.paused" tone="neutral" data-testid="schedule-card-paused">{{ card.paused }}</component>
      <component :is="parts.FnPill" v-if="parts" :name="card.fn" />
      <code v-else class="fn">{{ card.fn }}</code>
    </header>
    <p class="says" data-testid="schedule-card-says">{{ card.says }}</p>
    <ul v-if="card.next.length > 0" class="next" data-testid="schedule-card-next" aria-label="Next runs">
      <li v-for="run in card.next" :key="run">{{ run }}</li>
    </ul>
    <p v-else-if="!card.paused" class="note">No runs to come.</p>
    <p class="note" data-testid="schedule-card-notifies">{{ card.notifies }}</p>
    <p v-if="card.allowed" class="note" data-testid="schedule-card-allowed">{{ card.allowed }}</p>
    <p v-if="card.last" class="last" data-testid="schedule-card-last">
      <component :is="parts.Badge" v-if="parts" :tone="card.last.tone" dot>{{ card.last.word }}</component>
      <span v-else>{{ card.last.word }}</span>
      <span v-if="card.last.summary" class="summary">{{ card.last.summary }}</span>
    </p>
    <p v-if="card.firstArgs" class="note" data-testid="schedule-card-args">The next run gets <code>{{ card.firstArgs }}</code></p>
    <a class="history" :href="card.historyHref" @click="open($event, card.historyHref)">History</a>
  </article>
</template>

<style scoped>
.schedule { display: grid; gap: var(--space-1); min-width: 0; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.title { color: var(--text); font-size: var(--text-sm); font-weight: var(--weight-strong); text-decoration: none; }
.title:hover { color: var(--accent); text-decoration: underline; }
.fn { font-size: var(--text-xs); color: var(--text-dim); }
.says { margin: 0; font-size: var(--text-sm); font-weight: var(--weight-medium); }
.next { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: 0; padding: 0; list-style: none; color: var(--text-dim); font-size: var(--text-sm); }
.note { margin: 0; color: var(--text-dim); font-size: var(--text-sm); overflow-wrap: anywhere; }
.last { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--text-sm); }
.summary { color: var(--text-dim); overflow-wrap: anywhere; }
.history { justify-self: start; color: var(--accent); font-size: var(--text-sm); text-decoration: none; }
.history:hover { text-decoration: underline; }
</style>
