<script setup lang="ts">
/**
 * The result of `schedule/list`: each of the person's schedules as a card, and a link to the calendar; none says so.
 */
import { CHAT_HOST, type ResultViewOf } from '@harness/sdk';
import type { schedule } from '../shared/index.ts';
import { computed, inject } from 'vue';
import ScheduleCard from './ScheduleCard.vue';
import { calendarHref, listCards } from './results.ts';

const props = defineProps<ResultViewOf<typeof schedule, 'list'>>();
const cards = computed(() => listCards(props.result));
const chat = inject(CHAT_HOST, undefined);
const calendar = calendarHref();

function open(event: MouseEvent): void {
  if (chat === undefined || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) { return; }
  event.preventDefault();
  chat.navigate(calendar);
}
</script>

<template>
  <section class="schedules" data-testid="schedule-list">
    <ScheduleCard v-for="card in cards" :key="card.name" :card="card" />
    <p v-if="cards.length === 0" class="none" data-testid="schedule-list-none">No schedules.</p>
    <a class="calendar" :href="calendar" @click="open">Open the Schedule page</a>
  </section>
</template>

<style scoped>
.schedules { display: grid; gap: var(--space-3); min-width: 0; }
.none { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
.calendar { justify-self: start; color: var(--accent); font-size: var(--text-sm); text-decoration: none; }
.calendar:hover { text-decoration: underline; }
</style>
