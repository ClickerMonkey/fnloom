<script setup lang="ts">
/**
 * The result of `schedule/change` (a `ScheduleView`), drawn as the schedule's card, as `schedule/add`'s is
 * (`ScheduleResult`); a result that doesn't read as a schedule says so rather than drawing nothing.
 */
import type { ResultViewOf } from '@harness/sdk';
import { computed } from 'vue';
import type { schedule } from '../shared/index.ts';
import ScheduleCard from './ScheduleCard.vue';
import { scheduleCard } from './results.ts';

const props = defineProps<ResultViewOf<typeof schedule, 'change'>>();
const card = computed(() => scheduleCard(props.result));
</script>

<template>
  <ScheduleCard v-if="card" :card="card" />
  <p v-else class="unread" data-testid="schedule-unread">This schedule's result doesn't read.</p>
</template>

<style scoped>
.unread { margin: 0; color: var(--text-dim); font-size: var(--text-sm); }
</style>
