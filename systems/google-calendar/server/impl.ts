/**
 * The Google Calendar implementation: every fn acts as the person whose connection the run carries (the hub picks it:
 * the caller's own, else one shared with them, and leaves out fns the person switched off or asks first where they
 * said so), and hands refreshed tokens back with `ctx.updateConnection`. Its connect flow (`connect`) is what the
 * hub's connect page drives.
 */
import type { FnError } from '@harness/core';
import type { FnCtx, FnTypes, Outcome, SystemImpl } from '@harness/sdk';
import type { CalendarConfigValue, CalendarContract, EventValue } from '../shared/index.ts';
import { CalendarSession, endAfter, eventOf, instantOf, timeOf, writeOf } from './calendar.ts';
import { CalendarConnector } from './connector.ts';
import type { CalendarSettings } from './env.ts';
import { GoogleProblem, type GoogleApi, type GoogleProblemCode } from './google.ts';

/** Everything the implementation is built from. */
export interface CalendarDeps {
  readonly settings: CalendarSettings;
  readonly api: GoogleApi;
  readonly now: () => number;
}

/** The error class each Google problem fails a run with. */
const PROBLEM_CLASS: Record<GoogleProblemCode, FnError['class']> = {
  unauthorized: 'fatal', expired: 'fatal', forbidden: 'caller', 'not-found': 'caller', invalid: 'caller', busy: 'retry', network: 'retry', garbled: 'retry',
};

type CalendarCtx<T extends FnTypes> = FnCtx<T, CalendarConfigValue>;

/** Build the implementation. */
export function createCalendarImpl(deps: CalendarDeps): SystemImpl<CalendarContract['defs']> {
  const s = deps.settings;

  /** Run fn code with the person's calendar, turning Google's problems into failures and a missing connection into one. */
  async function withCalendar<T extends FnTypes>(ctx: CalendarCtx<T>, work: (calendar: CalendarSession) => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const connection = ctx.connection;
    if (connection === undefined) { return ctx.fail('caller', 'Your Google Calendar isn\'t connected: connect it on the Calendar page first.', { code: 'not-connected' }); }
    try {
      const calendar = new CalendarSession({ api: deps.api, client: ctx.config, connection, now: deps.now, skew: s.CALENDAR_REFRESH_SKEW, update: (update) => ctx.updateConnection(update.update) });
      return await work(calendar);
    } catch (error) {
      if (!(error instanceof GoogleProblem)) { throw error; }
      ctx.log.warn('calendar.google.failed', { code: error.code });
      return ctx.fail(PROBLEM_CLASS[error.code], error.message, { code: error.code === 'expired' || error.code === 'unauthorized' ? 'reconnect' : error.code });
    }
  }

  /** Events from the calendars in a range, earliest first, cut to the limit. */
  async function eventsIn(calendar: CalendarSession, calendars: string[], range: { from: string; to: string; q?: string }, limit: number): Promise<{ events: EventValue[]; more: boolean }> {
    const pages = await Promise.all(calendars.map(async (id) => {
      const page = await calendar.call((token) => deps.api.events(token, id, { timeMin: range.from, timeMax: range.to, maxResults: limit, ...(range.q === undefined ? {} : { q: range.q }) }));
      return { more: page.more, events: page.items.map((event) => eventOf(event, id)) };
    }));
    const events = pages.flatMap((page) => page.events).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { events: events.slice(0, limit), more: events.length > limit || pages.some((page) => page.more) };
  }

  /** A range from the args, with defaults around now; `undefined` names the arg that isn't a time. */
  function rangeOf(args: { from?: string | undefined; to?: string | undefined }, back: number, ahead: number): { from: string; to: string } | { bad: 'from' | 'to' } {
    const now = deps.now();
    const from = args.from === undefined ? new Date(now - back).toISOString() : instantOf(args.from);
    if (from === undefined) { return { bad: 'from' }; }
    const to = args.to === undefined ? new Date(Date.parse(from) + ahead + back).toISOString() : instantOf(args.to);
    return to === undefined ? { bad: 'to' } : { from, to };
  }

  const badTime = (path: string) => [{ path, message: 'Give an ISO date-time with its offset (2026-11-08T09:00:00-05:00) or a date (2026-11-08).' }];

  const connector = new CalendarConnector(deps.api, deps.now);
  return {
    fns: {
      list_events: {
        run: (args, ctx) => withCalendar(ctx, async (calendar) => {
          const range = rangeOf(args, 0, s.CALENDAR_LIST_AHEAD);
          if ('bad' in range) { return ctx.invalid(badTime(range.bad)); }
          return ctx.done(await eventsIn(calendar, calendar.calendarsFor(args.calendar), range, args.limit ?? s.CALENDAR_LIMIT));
        }),
      },
      search_events: {
        run: (args, ctx) => withCalendar(ctx, async (calendar) => {
          const range = rangeOf(args, s.CALENDAR_SEARCH_BACK, s.CALENDAR_SEARCH_AHEAD);
          if ('bad' in range) { return ctx.invalid(badTime(range.bad)); }
          return ctx.done(await eventsIn(calendar, calendar.calendarsFor(args.calendar), { ...range, q: args.query }, args.limit ?? s.CALENDAR_LIMIT));
        }),
      },
      get_event: {
        run: (args, ctx) => withCalendar(ctx, async (calendar) => {
          const id = calendar.calendarFor(args.calendar);
          return ctx.done(eventOf(await calendar.call((token) => deps.api.event(token, id, args.id)), id));
        }),
      },
      create_event: {
        run: (args, ctx) => withCalendar(ctx, async (calendar) => {
          const start = timeOf(args.start, ctx.run.time.timeZone);
          if (start === undefined) { return ctx.invalid(badTime('start')); }
          const end = args.end === undefined ? endAfter(start) : timeOf(args.end, ctx.run.time.timeZone);
          if (end === undefined) { return ctx.invalid(badTime('end')); }
          if ((start.date === undefined) !== (end.date === undefined)) { return ctx.invalid([{ path: 'end', message: 'Give the start and the end both as dates (all day) or both as date-times.' }]); }
          const id = calendar.calendarFor(args.calendar);
          const made = await calendar.call((token) => deps.api.insert(token, id, { ...writeOf(args), start, end }));
          ctx.log.info('calendar.created', { calendar: id });
          return ctx.done(eventOf(made, id));
        }),
      },
      update_event: {
        run: (args, ctx) => withCalendar(ctx, async (calendar) => {
          const start = args.start === undefined ? undefined : timeOf(args.start, ctx.run.time.timeZone);
          if (args.start !== undefined && start === undefined) { return ctx.invalid(badTime('start')); }
          const end = args.end === undefined ? undefined : timeOf(args.end, ctx.run.time.timeZone);
          if (args.end !== undefined && end === undefined) { return ctx.invalid(badTime('end')); }
          const id = calendar.calendarFor(args.calendar);
          const changed = await calendar.call((token) => deps.api.patch(token, id, args.id, { ...writeOf(args), ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }) }));
          ctx.log.info('calendar.updated', { calendar: id });
          return ctx.done(eventOf(changed, id));
        }),
      },
      delete_event: {
        run: (args, ctx) => withCalendar(ctx, async (calendar) => {
          const id = calendar.calendarFor(args.calendar);
          const event = await calendar.call((token) => deps.api.event(token, id, args.id));
          await calendar.call((token) => deps.api.remove(token, id, args.id));
          ctx.log.info('calendar.deleted', { calendar: id });
          return ctx.done({ deleted: true, title: event.summary ?? '(no title)' });
        }),
      },
    },
    connect: {
      start: (request, ctx) => connector.start(ctx.config, request),
      finish: (request, ctx) => connector.finish(ctx.config, request),
      disconnect: async (connection, ctx) => {
        if (!await connector.disconnect(connection)) { ctx.log.warn('calendar.revoke.skipped', { connection: connection.id }); }
      },
    },
    lifecycle: {
      configured: (ctx) => {
        ctx.log.info('calendar.configured', { hub: ctx.config.hubUrl });
        return Promise.resolve();
      },
    },
  };
}
