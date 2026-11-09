/**
 * A person's calendar for one run: their connection's tokens (refreshed when they are about to run out or Google
 * refuses them, each refresh handed back to the hub), their settings, and the event operations the fns run, with
 * Google's events turned into this system's `Event` values and the fns' args into Google's fields.
 */
import { Json, type ActorId, type ConnectionUpdate, type RunConnection } from '@harness/core';
import { parseValue } from '@harness/sdk';
import { z } from 'zod';
import { ConnectionSettings, type ConnectionSettingsValue, type EventValue } from '../shared/index.ts';
import { GoogleProblem, type EventTime, type EventWrite, type GoogleApi, type GoogleEvent, type OAuthClient, type TokenAnswer } from './google.ts';

/** What the hub keeps as a connection's credentials. */
export const Credentials = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number() });
export type Credentials = z.infer<typeof Credentials>;

/** New credentials from a token answer; a refresh keeps the refresh token it had when Google sends none. */
export function credentialsOf(tokens: TokenAnswer, now: number, refreshToken: string): Credentials {
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? refreshToken, expiresAt: now + tokens.expires_in * 1_000 };
}

/** A person's settings, with defaults for anything missing or unreadable. */
export function settingsOf(settings: Json): ConnectionSettingsValue {
  try {
    return parseValue(ConnectionSettings, settings);
  } catch {
    return {};
  }
}

/** A start or end as Google takes it: a date for all day, else a date-time in the person's time zone. Undefined when it is neither. */
export function timeOf(text: string, timeZone: string): EventTime | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) { return Number.isNaN(Date.parse(text)) ? undefined : { date: text }; }
  return Number.isNaN(Date.parse(text)) ? undefined : { dateTime: text, timeZone };
}

/** A date-time that says its offset (`Z` or `±hh:mm`). */
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** The end of an event given only its start: the next day for all day, an hour later otherwise. */
export function endAfter(start: EventTime): EventTime {
  if (start.date !== undefined) { return { date: new Date(Date.parse(start.date) + 86_400_000).toISOString().slice(0, 10) }; }
  const dateTime = start.dateTime ?? '';
  if (HAS_OFFSET.test(dateTime)) { return { ...start, dateTime: new Date(Date.parse(dateTime) + 3_600_000).toISOString() }; }
  // a wall-clock time in the person's zone: add the hour to the clock, not through this machine's zone
  const later = new Date(Date.parse(`${dateTime}Z`) + 3_600_000).toISOString();
  return { ...start, dateTime: later.slice(0, later.length - 1) };
}

/** An instant as an RFC 3339 time for a range (a date is its start, UTC). */
export function instantOf(text: string): string | undefined {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Google's event as this system's `Event`. */
export function eventOf(event: GoogleEvent, calendar: string): EventValue {
  const allDay = event.start?.date !== undefined;
  return {
    id: event.id,
    calendar,
    title: event.summary ?? '(no title)',
    start: event.start?.dateTime ?? event.start?.date ?? '',
    end: event.end?.dateTime ?? event.end?.date ?? '',
    allDay,
    attendees: (event.attendees ?? []).flatMap((attendee) => (attendee.email === undefined ? [] : [attendee.email])),
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.organizer?.email === undefined ? {} : { organizer: event.organizer.email }),
    ...(event.htmlLink === undefined ? {} : { link: event.htmlLink }),
    ...(event.status === undefined ? {} : { status: event.status }),
  };
}

/** The fields of an event write that the args give. */
export function writeOf(args: { title?: string | undefined; description?: string | undefined; location?: string | undefined; attendees?: string[] | undefined }): EventWrite {
  return {
    ...(args.title === undefined ? {} : { summary: args.title }),
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.location === undefined ? {} : { location: args.location }),
    ...(args.attendees === undefined ? {} : { attendees: args.attendees.map((email) => ({ email })) }),
  };
}

/** What a calendar session is built from. */
export interface CalendarSessionDeps {
  readonly api: GoogleApi;
  readonly client: OAuthClient;
  readonly connection: RunConnection;
  /** The person the run is for: anyone but the connection's owner reaches only the calendars the owner chose. */
  readonly caller: ActorId;
  readonly now: () => number;
  /** Refresh this long before the access token runs out. */
  readonly skew: number;
  /** Hand refreshed credentials (or that the connection expired) to the hub. */
  readonly update: (update: ConnectionUpdate) => Promise<void>;
}

/** One person's calendar for one run. */
export class CalendarSession {
  readonly settings: ConnectionSettingsValue;
  readonly #deps: CalendarSessionDeps;
  #credentials: Credentials;

  /** Throws `GoogleProblem` (`expired`) when the connection's credentials aren't this system's. */
  constructor(deps: CalendarSessionDeps) {
    this.#deps = deps;
    const credentials = Credentials.safeParse(deps.connection.credentials);
    if (!credentials.success) { throw new GoogleProblem('expired', 'This connection has no usable tokens; connect your calendar again.'); }
    this.#credentials = credentials.data;
    this.settings = settingsOf(deps.connection.settings);
  }

  /** The calendars to read: the one asked for, else the owner's chosen ones, else their primary. Throws `forbidden` for one the caller may not reach. */
  calendarsFor(asked: string | undefined): string[] {
    if (asked !== undefined) { return [this.#reachable(asked)]; }
    return this.#chosen();
  }

  /** The calendar an event is in or goes to: the one asked for, else the owner's default. Throws `forbidden` for one the caller may not reach. */
  calendarFor(asked: string | undefined): string {
    return this.#reachable(asked ?? this.#default());
  }

  #chosen(): string[] {
    const chosen = this.settings.calendars ?? [];
    return chosen.length > 0 ? chosen : ['primary'];
  }

  #default(): string {
    return this.settings.defaultCalendar ?? 'primary';
  }

  /**
   * A calendar the caller may reach: the owner reaches any their token does; someone the connection is shared with
   * reaches only the calendars the owner chose on the Calendar page and their default one.
   */
  #reachable(calendar: string): string {
    if (this.#deps.caller === this.#deps.connection.owner || calendar === this.#default() || this.#chosen().includes(calendar)) { return calendar; }
    throw new GoogleProblem('forbidden', `The calendar ${calendar} isn't one its owner shares; use one of: ${[...new Set([...this.#chosen(), this.#default()])].join(', ')}.`);
  }

  /** Run a Google call with a fresh token; a refused token is refreshed once and the call tried again. */
  async call<T>(work: (accessToken: string) => Promise<T>): Promise<T> {
    if (this.#credentials.expiresAt - this.#deps.skew <= this.#deps.now()) { await this.#refresh(); }
    try {
      return await work(this.#credentials.accessToken);
    } catch (error) {
      if (!(error instanceof GoogleProblem) || error.code !== 'unauthorized') { throw error; }
      await this.#refresh();
      return work(this.#credentials.accessToken);
    }
  }

  async #refresh(): Promise<void> {
    const { api, client, connection, now, update } = this.#deps;
    try {
      this.#credentials = credentialsOf(await api.refresh(client, this.#credentials.refreshToken), now(), this.#credentials.refreshToken);
    } catch (error) {
      if (error instanceof GoogleProblem && error.code === 'expired') { await update({ connection: connection.id, update: { expired: error.message } }); }
      throw error;
    }
    await update({ connection: connection.id, update: { credentials: Json.parse(this.#credentials), expiresAt: this.#credentials.expiresAt } });
  }
}
