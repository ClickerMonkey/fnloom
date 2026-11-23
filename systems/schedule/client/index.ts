/**
 * The schedule system's client, typed by its contract: its pages (docs/plans/schedule-system.md, "The schedule
 * page"): the calendar of the person's scheduled runs at `/s/schedule/calendar`, one schedule at
 * `/s/schedule/item/<schedule>`, and every schedule on the hub for admins at `/s/schedule/all`. They draw with the
 * app's own components (`host.components`); only the calendar grid is the system's own.
 *
 * Its result renderers ("Result renderer"): `schedule/add` and `change` as the schedule's card, `list` as one card per
 * schedule, and a run of a `schedule/schedule` fn (a firing, on its run page or in a chat) under a header naming the
 * schedule and when it was planned for, above the target's own result.
 */
// typescript-eslint can't see the types of .vue modules from .ts files; vue-tsc checks this file
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { schedule } from '../shared/index.ts';
import AllSchedulesPage from './AllSchedulesPage.vue';
import CalendarPage from './CalendarPage.vue';
import ChangeResult from './ChangeResult.vue';
import FiringResult from './FiringResult.vue';
import ScheduleListResult from './ScheduleListResult.vue';
import SchedulePage from './SchedulePage.vue';
import ScheduleResult from './ScheduleResult.vue';

export default client(schedule, {
  pages: { CalendarPage, SchedulePage, AllSchedulesPage },
  results: {
    fns: { add: ScheduleResult, change: ChangeResult, list: ScheduleListResult },
    kinds: { schedule: FiringResult },
  },
});
