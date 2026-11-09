/**
 * The Google Calendar system's contract (`shared/`): a per-person system. An admin sets the OAuth client once (its
 * config); then every person connects their own Google account on the "Calendar" page, picks the calendars to use,
 * and chooses which fns are on, which ask before acting, and who else may use the connection. Every fn acts as the
 * person whose connection the run carries.
 */
import { ConnectDecl } from '@harness/core';
import { type Infer, type ValueOf, fn, g, system, type, wireType } from '@harness/sdk';

/** A calendar event, as the fns give it. */
export const Event = type({
  description: 'A Google Calendar event: when it is, where, and who is coming.',
  shape: g.obj({
    id: g.text({ minLength: 1 }),
    /** The calendar it is on (`primary`, or a calendar id). */
    calendar: g.text({ minLength: 1 }),
    title: g.text(),
    /** An ISO date-time with its offset, or a date (`2026-11-08`) for an all-day event. */
    start: g.text(),
    end: g.text(),
    allDay: g.bool(),
    location: g.optional(g.text()),
    description: g.optional(g.text()),
    /** Attendees' email addresses. */
    attendees: g.list(g.text()),
    organizer: g.optional(g.text()),
    /** The event's page in Google Calendar. */
    link: g.optional(g.text()),
    status: g.optional(g.text()),
  }),
  display: { label: 'Event', plural: 'Events', icon: 'calendar', color: '#1a73e8', title: 'title', subtitle: 'start' },
});

/** A person's own settings for their connection: which calendars to read, and where new events go. */
export const ConnectionSettings = g.obj({
  calendars: g.field(g.optional(g.list(g.text({ minLength: 1 }))), { docs: 'The calendars the chat reads (ids). Empty: your primary calendar.' }),
  defaultCalendar: g.field(g.optional(g.text({ minLength: 1 })), { docs: 'Where new events go. Default: your primary calendar.' }),
});

const when = (what: string) => g.field(g.optional(g.text({ minLength: 1 })), { docs: `${what}: an ISO date-time (2026-11-08T09:00:00-05:00) or a date.` });
const calendar = () => g.field(g.optional(g.text({ minLength: 1 })), { docs: 'The calendar id; your own calendars when absent.' });
const limit = () => g.optional(g.num({ min: 1, max: 250, whole: true }));

/** The fields an event is made or changed with. */
const eventFields = {
  description: g.optional(g.text()),
  location: g.optional(g.text()),
  attendees: g.field(g.optional(g.list(g.text({ minLength: 3 }))), { docs: 'Email addresses to invite.' }),
};

/** Events, earliest first. */
export const Events = g.obj({ events: g.list(Event.shape), more: g.field(g.bool(), { docs: 'More events matched than the limit.' }) });

const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: `${active} ({n})` },
  retry: { one: `${active} (again)`, many: `${active} ({n}, again)` },
  done: { one: done, many: `${done} ({n})` },
  failed: { one: failed, many: `${failed} ({n})` },
});

/** The Google Calendar system's contract. */
export const googleCalendar = system('google-calendar', { description: 'Each person connects their Google Calendar; the chat can see their events and, as they allow, create, change and delete them.' })
  .with({
    config: g.obj({
      clientId: g.field(g.text({ minLength: 1 }), { docs: 'The OAuth client id from Google Cloud (a "Web application" client).' }),
      clientSecret: g.field(g.text({ minLength: 1 }), { docs: 'The OAuth client\'s secret.' }),
      hubUrl: g.field(g.text({ minLength: 1 }), { docs: 'The hub\'s public address (https://hub.example.com). Add `<hub>/connect/callback` to the client\'s redirect URIs.' }),
    }),
    types: { Event },
    fns: {
      list_events: fn({
        description: 'List the person\'s calendar events in a time range (the next 7 days by default), earliest first.',
        instructions: 'Give times with the person\'s offset (see the time in your context). Use search_events to find events by words.',
        args: g.obj({ from: when('From'), to: when('Until'), calendar: calendar(), limit: limit() }),
        returns: Events,
        status: status('Reading your calendar…', 'Read your calendar', 'Reading your calendar failed'),
        tags: ['read', 'calendar'],
      }),
      search_events: fn({
        description: 'Find the person\'s calendar events by words (title, description, location, attendees), from a month ago to a year ahead by default.',
        args: g.obj({ query: g.text({ minLength: 1 }), from: when('From'), to: when('Until'), calendar: calendar(), limit: limit() }),
        returns: Events,
        status: status('Searching your calendar for {args.query}…', 'Searched your calendar for {args.query}', 'Searching your calendar failed'),
        tags: ['read', 'calendar'],
      }),
      get_event: fn({
        description: 'One calendar event by its id.',
        args: g.obj({ id: g.text({ minLength: 1 }), calendar: calendar() }),
        returns: Event.shape,
        status: status('Reading an event…', 'Read {output.title}', 'Reading the event failed'),
        tags: ['read', 'calendar'],
      }),
      create_event: fn({
        description: 'Add an event to the person\'s calendar. Without an end it lasts an hour (or the day, for a date).',
        instructions: 'Say what you will add before you add it. Invite attendees only when the person named them.',
        args: g.obj({ title: g.text({ minLength: 1 }), start: g.field(g.text({ minLength: 1 }), { docs: 'An ISO date-time with offset, or a date for all day.' }), end: when('Ends'), calendar: calendar(), ...eventFields }),
        returns: Event.shape,
        status: status('Adding {args.title}…', 'Added {output.title}', 'Adding {args.title} failed'),
        tags: ['write', 'calendar'],
      }),
      update_event: fn({
        description: 'Change a calendar event: only the fields given change.',
        args: g.obj({ id: g.text({ minLength: 1 }), calendar: calendar(), title: g.optional(g.text({ minLength: 1 })), start: when('Starts'), end: when('Ends'), ...eventFields }),
        returns: Event.shape,
        status: status('Changing an event…', 'Changed {output.title}', 'Changing the event failed'),
        tags: ['write', 'calendar'],
      }),
      delete_event: fn({
        description: 'Delete a calendar event.',
        instructions: 'Only when the person asked for it, naming the event.',
        args: g.obj({ id: g.text({ minLength: 1 }), calendar: calendar() }),
        returns: g.obj({ deleted: g.bool(), title: g.text() }),
        status: status('Deleting an event…', 'Deleted {output.title}', 'Deleting the event failed'),
        tags: ['write', 'calendar'],
      }),
    },
  });

/** The contract's type. */
export type CalendarContract = typeof googleCalendar;
/** The fns that act as the person, by local name. */
export type CalendarFn = Extract<keyof CalendarContract['defs']['fns'], string>;
/** An event. */
export type EventValue = ValueOf<typeof Event>;
/** A person's settings. */
export type ConnectionSettingsValue = Infer<typeof ConnectionSettings>;
/** The system's config. */
export type CalendarConfigValue = Infer<CalendarContract['defs']['config']>;

/**
 * The system's `connect` declaration (manifest `connect`): the "Calendar" page, OAuth through the hub's redirect, the
 * person's settings, and each fn's default switches: reading is on and acts without asking, creating and changing
 * ask first, deleting is off until the person turns it on.
 */
export const CALENDAR_CONNECT: ConnectDecl = ConnectDecl.parse({
  title: 'Calendar',
  description: 'Connect your Google Calendar so the chat can see your events and, as you allow, add and change them.',
  icon: 'calendar',
  how: { flow: 'oauth' },
  settings: wireType(ConnectionSettings),
  fns: {
    list_events: { on: true, ask: false },
    search_events: { on: true, ask: false },
    get_event: { on: true, ask: false },
    create_event: { on: true, ask: true },
    update_event: { on: true, ask: true },
    delete_event: { on: false, ask: true },
  } satisfies Record<CalendarFn, { on: boolean; ask: boolean }>,
});
