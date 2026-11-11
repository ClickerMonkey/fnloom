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
  calendars: g.field(g.optional(g.list(g.text({ minLength: 1 }))), { docs: 'The calendars the chat reads. Empty: your primary calendar.' }),
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

/** The contract's declarations, before its `connect` (which names these fns). */
const declared = system('google-calendar', {
  description: 'Each person connects their Google Calendar; the chat can see their events and, as they allow, create, change and delete them.',
  grants: { hub: ['connections'] },
})
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
        instructions: 'Use it for "what is on today / this week". Give times with the person\'s offset (see the time in your context); a date alone means its whole day. Use search_events to find events by words instead of listing a long range.',
        args: g.obj({ from: when('From'), to: when('Until'), calendar: calendar(), limit: limit() }),
        returns: Events,
        examples: [
          { args: {}, note: 'The next 7 days.' },
          { args: { from: '2026-11-10', to: '2026-11-11' }, note: 'One day.' },
          { args: { from: '2026-11-10T13:00:00-05:00', to: '2026-11-10T18:00:00-05:00', limit: 20 }, note: 'An afternoon.' },
        ],
        effects: { mode: 'read' },
        status: status('Reading your calendar…', 'Read your calendar', 'Reading your calendar failed'),
        tags: ['read', 'calendar'],
      }),
      search_events: fn({
        description: 'Find the person\'s calendar events by words (title, description, location, attendees), from a month ago to a year ahead by default.',
        instructions: 'Use a few distinctive words ("dentist", a person\'s name), not a sentence. Narrow with from and to when the person says when. Use the id of a hit with get_event, update_event or delete_event.',
        args: g.obj({ query: g.text({ minLength: 1 }), from: when('From'), to: when('Until'), calendar: calendar(), limit: limit() }),
        returns: Events,
        examples: [{ args: { query: 'dentist' } }, { args: { query: 'Ada', from: '2026-11-01', to: '2026-12-31' }, note: 'Meetings with Ada this year.' }],
        effects: { mode: 'read' },
        status: status('Searching your calendar for {args.query}…', 'Searched your calendar for {args.query}', 'Searching your calendar failed'),
        tags: ['read', 'calendar'],
      }),
      get_event: fn({
        description: 'One calendar event by its id.',
        instructions: 'Use the id from list_events or search_events, with the same calendar when the event is not on the person\'s own calendars.',
        args: g.obj({ id: g.text({ minLength: 1 }), calendar: calendar() }),
        returns: Event.shape,
        examples: [{ args: { id: '5f2k9q8h1v0c3m7n' } }],
        effects: { mode: 'read' },
        status: status('Reading an event…', 'Read {output.title}', 'Reading the event failed'),
        tags: ['read', 'calendar'],
      }),
      create_event: fn({
        description: 'Add an event to the person\'s calendar. Without an end it lasts an hour (or the day, for a date).',
        instructions: 'Say what you will add before you add it. Use the person\'s offset; give a date as start for an all-day event. Invite attendees only when the person named them, by email.',
        examples: [
          { args: { title: 'Dentist', start: '2026-11-12T15:30:00-05:00', end: '2026-11-12T16:15:00-05:00', location: '12 High St' } },
          { args: { title: 'Mum\'s birthday', start: '2026-12-02' }, note: 'All day.' },
          { args: { title: 'Planning', start: '2026-11-13T10:00:00-05:00', attendees: ['ada@example.com'] }, note: 'An hour, with one guest invited.' },
        ],
        effects: { mode: 'write' },
        args: g.obj({ title: g.text({ minLength: 1 }), start: g.field(g.text({ minLength: 1 }), { docs: 'An ISO date-time with offset, or a date for all day.' }), end: when('Ends'), calendar: calendar(), ...eventFields }),
        returns: Event.shape,
        status: status('Adding {args.title}…', 'Added {output.title}', 'Adding {args.title} failed'),
        tags: ['write', 'calendar'],
      }),
      update_event: fn({
        description: 'Change a calendar event: only the fields given change.',
        instructions: 'Find the event first (search_events) and say what will change. Move an event by giving both start and end; leave out every field that stays.',
        examples: [
          { args: { id: '5f2k9q8h1v0c3m7n', start: '2026-11-12T16:00:00-05:00', end: '2026-11-12T16:45:00-05:00' }, note: 'Moved half an hour later.' },
          { args: { id: '5f2k9q8h1v0c3m7n', location: 'Room 4' } },
        ],
        effects: { mode: 'write' },
        args: g.obj({ id: g.text({ minLength: 1 }), calendar: calendar(), title: g.optional(g.text({ minLength: 1 })), start: when('Starts'), end: when('Ends'), ...eventFields }),
        returns: Event.shape,
        status: status('Changing an event…', 'Changed {output.title}', 'Changing the event failed'),
        tags: ['write', 'calendar'],
      }),
      delete_event: fn({
        description: 'Delete a calendar event.',
        instructions: 'Only when the person asked for it, naming the event: find it first and say which one you will delete. Guests are told it is cancelled.',
        examples: [{ args: { id: '5f2k9q8h1v0c3m7n' }, result: { deleted: true, title: 'Dentist' } }],
        effects: { mode: 'delete' },
        args: g.obj({ id: g.text({ minLength: 1 }), calendar: calendar() }),
        returns: g.obj({ deleted: g.bool(), title: g.text() }),
        status: status('Deleting an event…', 'Deleted {output.title}', 'Deleting the event failed'),
        tags: ['write', 'calendar'],
      }),
    },
  });

/** The fns that act as the person, by local name. */
export type CalendarFn = Extract<keyof typeof declared.defs.fns, string>;
/** An event. */
export type EventValue = ValueOf<typeof Event>;
/** A person's settings. */
export type ConnectionSettingsValue = Infer<typeof ConnectionSettings>;
/** The system's config. */
export type CalendarConfigValue = Infer<typeof declared.defs.config>;

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

/** The Google Calendar system's contract: its fns, and the per-person `connect` they act through. */
export const googleCalendar = declared.with({ connect: CALENDAR_CONNECT });

/** The contract's type. */
export type CalendarContract = typeof googleCalendar;
