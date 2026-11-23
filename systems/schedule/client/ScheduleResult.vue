<script setup lang="ts">
/**
 * The result of `schedule/add` (a `ScheduleView`), drawn as the schedule's card; a result that doesn't read as a
 * schedule says so rather than drawing nothing. `schedule/change`'s is `ChangeResult`, the same card.
 */
import type { ResultViewOf } from '@harness/sdk';
import { computed } from 'vue';
import type { schedule } from '../shared/index.ts';
import ScheduleCard from './ScheduleCard.vue';
import { scheduleCard } from './results.ts';

const props = defineProps<ResultViewOf<typeof schedule, 'add'>>();
const card = computed(() => scheduleCard(props.result));
</script>

<template>
  <ScheduleCard v-if="card" :card="card" />
  <p v-else class="unread" data-testid="schedule-unread">This schedule's result doesn't read.</p>
</template>

<style scoped>
.unread { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
