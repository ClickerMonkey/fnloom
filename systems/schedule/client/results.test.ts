/**
 * The schedule system's result renderers: the client module registers `add`, `change` and `list` by fn and a firing's
 * run by the kind; a schedule's view reads as a card (its words, next runs, pause, when it notifies, its last run, the
 * next run's args and links to its page), a list as one card per schedule; a firing's header says when it was planned
 * for in the viewer's zone (or that it was run by hand) and links to the history; and the components draw them, a link
 * moving the chat's app on a plain click, the target's result under a firing's header in the app's result view.
 */
import { mintId, QualifiedName, type RunId } from '@harness/core';
import { APP_COMPONENTS, CHAT_HOST, RESULT_VIEW, type ChatHost, type FnPillProps, type ResultViewProps, type SharedComponents, type SystemClient } from '@harness/sdk';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, type Component } from 'vue';
import { ScheduleView, type ScheduleContract } from '../shared/index.ts';
import FiringResult from './FiringResult.vue';
import module from './index.ts';
import { firingHeader, listCards, scheduleCard, scheduleHref } from './results.ts';
import ScheduleListResult from './ScheduleListResult.vue';
import ScheduleResult from './ScheduleResult.vue';

/** Monday 30 November 2026, 9:00 in New York. */
const MON_9 = Date.UTC(2026, 10, 30, 14, 0);
const VIEW = {
  schedule: 'schedule/weekly_orders_summary', fn: 'database/main.orders_by_week', says: 'Every week on Monday at 9:00 am', zone: 'America/New_York', notify: 'failed',
  next: [{ at: MON_9, local: 'Mon, Nov 30 9:00 am' }, { at: MON_9 + 7 * 86_400_000, local: 'Mon, Dec 7 9:00 am' }],
  firstArgs: { week_start: '2026-11-23' },
  last: { at: MON_9 - 7 * 86_400_000, status: 'ran', summary: '12 rows: Widgets $1,240' },
};

const shown: ResultViewProps[] = [];
const ResultStub = defineComponent((props: ResultViewProps) => {
  shown.push(props);
  return () => h('div', { 'data-testid': 'result-view' }, props.title);
}, { props: ['value', 'title', 'fn', 'args', 'viewKey', 'keepLook'] });
/** Stand-ins for the app's components: enough to draw. */
const slot = (tag: string): Component => defineComponent({ setup(_, { slots }) { return () => h(tag, slots['default']?.()); } });
const parts: SharedComponents = {
  Frame: slot('main'), LoadState: slot('section'), Icon: slot('i'), Badge: slot('em'), Input: slot('input'),
  Markdown: slot('div'), Empty: slot('div'), Reasoning: slot('div'), Typing: slot('div'), ResourceViewer: slot('div'), ValueEditor: slot('div'),
  Select: slot('div'), Textarea: slot('div'), Dialog: slot('div'), Banner: slot('div'), Skeleton: slot('div'), Approval: slot('div'), Conversation: slot('div'), Composer: slot('div'),
  Button: slot('button'),
  FnPill: defineComponent((props: FnPillProps) => () => h('span', { class: 'pill' }, props.name), { props: ['name', 'off'] }),
};
/** The schedule system's client: no run is started by the result renderers. */
const start = (): Promise<RunId> => Promise.reject(new Error('the result renderers start no runs'));
const system: SystemClient<ScheduleContract['defs']> = {
  online: true, send: {},
  run: { add: start, change: start, list: start, pause: start, resume: start, skip: start, remove: start, history: start, remind: start },
};
const view = ScheduleView.parse(VIEW);

function chatHost(): ChatHost & { paths: string[] } {
  const paths: string[] = [];
  return { paths, ask: () => Promise.resolve(true), settled: () => Promise.resolve({ ok: true, output: null }), navigate: (path) => { paths.push(path); } };
}

describe('the schedule result renderers', () => {
  it('are registered for add, change and list, and for a run of the schedule kind', () => {
    expect(Object.keys(module.renderers.results?.fns ?? {}).sort()).toEqual(['add', 'change', 'list']);
    expect(Object.keys(module.renderers.results?.kinds ?? {})).toEqual(['schedule']);
  });

  it('read a schedule as a card, a list as cards, and refuse what isn\'t one', () => {
    expect(scheduleCard(VIEW)).toEqual({
      name: 'schedule/weekly_orders_summary', title: 'Weekly orders summary', fn: 'database/main.orders_by_week', says: 'Every week on Monday at 9:00 am',
      next: ['Mon, Nov 30 9:00 am', 'Mon, Dec 7 9:00 am'], notifies: 'Notifies you only when a run fails',
      last: { word: 'Ran', tone: 'ok', summary: '12 rows: Widgets $1,240' }, firstArgs: '{"week_start":"2026-11-23"}',
      href: '/s/schedule/item/weekly_orders_summary', historyHref: '/s/schedule/item/weekly_orders_summary?tab=history',
    });
    expect(scheduleCard({ ...VIEW, paused: {}, next: [] })?.paused).toBe('Paused until resumed');
    expect(scheduleCard({ ...VIEW, paused: { until: '2027-01-04' } })?.paused).toBe('Paused until 2027-01-04');
    expect(scheduleCard({ nope: true })).toBeUndefined();
    expect(listCards({ items: [VIEW, { nope: true }, { ...VIEW, schedule: 'schedule/other' }] }).map((card) => card.name)).toEqual(['schedule/weekly_orders_summary', 'schedule/other']);
    expect(scheduleHref('schedule/x', { firing: '2026-11-30T09:00' })).toBe('/s/schedule/item/x?firing=2026-11-30T09%3A00');
  });

  it('say when a firing was planned for in the viewer\'s zone, or that it was run by hand', () => {
    expect(firingHeader('schedule/weekly_orders_summary', { at: MON_9 }, 'America/New_York', MON_9 - 3 * 86_400_000)).toEqual({
      title: 'Weekly orders summary', when: 'Planned for Mon, Nov 30, 9:00 am', href: '/s/schedule/item/weekly_orders_summary', historyHref: '/s/schedule/item/weekly_orders_summary?tab=history',
    });
    expect(firingHeader('schedule/weekly_orders_summary', {}, 'UTC').when).toBe('Run by hand, outside its times');
  });

  it('draw a schedule\'s card, moving the chat\'s app on a plain click, and a list with a link to the calendar', async () => {
    const chat = chatHost();
    const global = { provide: { [CHAT_HOST]: chat, [APP_COMPONENTS]: parts } };
    const run = mintId('run');
    const card = mount(ScheduleResult, { props: { run, fn: QualifiedName.parse('schedule/add'), args: { fn: view.fn, when: { dayOfWeek: [1], times: ['09:00'] } }, result: view, title: 'Add', system }, global });
    expect(card.get('[data-testid="schedule-card-says"]').text()).toBe('Every week on Monday at 9:00 am');
    expect(card.get('[data-testid="schedule-card-next"]').text()).toContain('Mon, Dec 7 9:00 am');
    expect(card.get('[data-testid="schedule-card-notifies"]').text()).toBe('Notifies you only when a run fails');
    expect(card.get('[data-testid="schedule-card-args"]').text()).toContain('week_start');
    await card.get('[data-testid="schedule-card-link"]').trigger('click', { button: 0 });
    expect(chat.paths).toEqual(['/s/schedule/item/weekly_orders_summary']);
    const list = mount(ScheduleListResult, { props: { run, fn: QualifiedName.parse('schedule/list'), args: {}, result: { items: [view] }, title: 'List', system }, global });
    expect(list.findAll('[data-testid="schedule-card"]')).toHaveLength(1);
    const none = mount(ScheduleListResult, { props: { run, fn: QualifiedName.parse('schedule/list'), args: {}, result: { items: [] }, title: 'List', system }, global });
    expect(none.get('[data-testid="schedule-list-none"]').text()).toBe('No schedules.');
  });

  it('draw a firing\'s run under its header, with the target\'s result in the app\'s result view', () => {
    shown.length = 0;
    const run = mintId('run');
    const view = mount(FiringResult, {
      props: { run, fn: QualifiedName.parse('schedule/weekly_orders_summary'), args: { at: MON_9 }, result: { summary: 'Done' }, title: 'Weekly orders summary', system },
      global: { provide: { [RESULT_VIEW]: ResultStub } },
    });
    expect(view.get('[data-testid="schedule-firing-when"]').text()).toMatch(/^Planned for /);
    expect(shown).toMatchObject([{ value: { summary: 'Done' }, fn: 'schedule/weekly_orders_summary', viewKey: run }]);
  });
});
