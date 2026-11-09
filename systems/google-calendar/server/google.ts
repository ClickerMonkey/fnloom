/**
 * Google's OAuth and Calendar APIs, behind `GoogleApi`: `FetchGoogleApi` calls the real endpoints with a `fetch`
 * (OAuth 2 code flow with offline access, token refresh and revoke, the account's email, calendars and events);
 * tests use `FakeGoogleApi` (`fake.ts`). Every answer is checked with the zod schemas here, and every failure is a
 * `GoogleProblem` with a code the fns can act on.
 */
import { z } from 'zod';

/** What can go wrong talking to Google. */
export type GoogleProblemCode = 'unauthorized' | 'expired' | 'forbidden' | 'not-found' | 'invalid' | 'busy' | 'network' | 'garbled';

/** A failed Google call. */
export class GoogleProblem extends Error {
  override readonly name = 'GoogleProblem';
  readonly code: GoogleProblemCode;
  constructor(code: GoogleProblemCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** The OAuth client an admin configured. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Tokens from Google's token endpoint. `refreshToken` comes only with the first consent. */
export const TokenAnswer = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});
export type TokenAnswer = z.infer<typeof TokenAnswer>;

/** The signed-in account. */
export const Account = z.object({ email: z.string(), name: z.string().optional() });
export type Account = z.infer<typeof Account>;

/** One of the account's calendars. */
export const GoogleCalendarEntry = z.object({ id: z.string(), summary: z.string().optional(), primary: z.boolean().optional(), accessRole: z.string().optional() });
export type GoogleCalendarEntry = z.infer<typeof GoogleCalendarEntry>;

/** An event's start or end: a date-time, or a date for all day. */
export const EventTime = z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() });
export type EventTime = z.infer<typeof EventTime>;

/** A Google Calendar event (the fields this system reads). */
export const GoogleEvent = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  htmlLink: z.string().optional(),
  start: EventTime.optional(),
  end: EventTime.optional(),
  attendees: z.array(z.object({ email: z.string().optional() })).optional(),
  organizer: z.object({ email: z.string().optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof GoogleEvent>;

/** What an event is made or changed with (Google's own field names). */
export const EventWrite = GoogleEvent.omit({ id: true, status: true, htmlLink: true, organizer: true }).partial();
export type EventWrite = z.infer<typeof EventWrite>;

/** A page of events. */
export const EventPage = z.object({ items: z.array(GoogleEvent).default([]), nextPageToken: z.string().optional() });

/** How events are looked up. */
export interface EventQuery {
  readonly timeMin: string;
  readonly timeMax: string;
  readonly q?: string;
  readonly maxResults: number;
}

/** Google, as this system uses it. */
export interface GoogleApi {
  /** Where to send the person to consent. */
  authUrl(client: OAuthClient, redirect: string, state: string): string;
  /** Trade the code from the redirect for tokens. */
  exchange(client: OAuthClient, code: string, redirect: string): Promise<TokenAnswer>;
  /** New access token from a refresh token; `expired` when Google refuses it. */
  refresh(client: OAuthClient, refreshToken: string): Promise<TokenAnswer>;
  /** Revoke a token (best effort). */
  revoke(token: string): Promise<void>;
  account(accessToken: string): Promise<Account>;
  calendars(accessToken: string): Promise<GoogleCalendarEntry[]>;
  /** Events in a range, earliest first; `more` when there were more than `maxResults`. */
  events(accessToken: string, calendar: string, query: EventQuery): Promise<{ items: GoogleEvent[]; more: boolean }>;
  event(accessToken: string, calendar: string, id: string): Promise<GoogleEvent>;
  insert(accessToken: string, calendar: string, event: EventWrite): Promise<GoogleEvent>;
  patch(accessToken: string, calendar: string, id: string, changes: EventWrite): Promise<GoogleEvent>;
  remove(accessToken: string, calendar: string, id: string): Promise<void>;
}

/** Google's addresses (tests point them at a fake server). */
export interface GoogleEndpoints {
  readonly auth: string;
  readonly token: string;
  readonly revoke: string;
  readonly userinfo: string;
  readonly calendar: string;
}

/** The real addresses. */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  calendar: 'https://www.googleapis.com/calendar/v3',
};

/** The scopes asked for: who the person is, their calendar list, and their events. */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'] as const;

/** The problem for a failed status. */
function problemFor(status: number, text: string): GoogleProblem {
  const detail = text.slice(0, 300);
  if (status === 401) { return new GoogleProblem('unauthorized', `Google refused the access token: ${detail}`); }
  if (status === 403) { return new GoogleProblem(/rate|quota/i.test(text) ? 'busy' : 'forbidden', `Google refused: ${detail}`); }
  if (status === 404 || status === 410) { return new GoogleProblem('not-found', 'Google has no such event or calendar.'); }
  if (status === 429 || status >= 500) { return new GoogleProblem('busy', `Google is busy (${status}).`); }
  return new GoogleProblem('invalid', `Google refused the request (${status}): ${detail}`);
}

/** `GoogleApi` over `fetch`. */
export class FetchGoogleApi implements GoogleApi {
  readonly #fetch: typeof fetch;
  readonly #endpoints: GoogleEndpoints;
  readonly #timeout: number;

  constructor(options: { fetch: typeof fetch; endpoints?: GoogleEndpoints; timeout: number }) {
    this.#fetch = options.fetch;
    this.#endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
    this.#timeout = options.timeout;
  }

  authUrl(client: OAuthClient, redirect: string, state: string): string {
    const url = new URL(this.#endpoints.auth);
    const params = { client_id: client.clientId, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state };
    for (const [key, value] of Object.entries(params)) { url.searchParams.set(key, value); }
    return url.href;
  }

  async exchange(client: OAuthClient, code: string, redirect: string): Promise<TokenAnswer> {
    return TokenAnswer.parse(await this.#form(this.#endpoints.token, { code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }));
  }

  async refresh(client: OAuthClient, refreshToken: string): Promise<TokenAnswer> {
    try {
      return TokenAnswer.parse(await this.#form(this.#endpoints.token, { refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token' }));
    } catch (error) {
      // a refused refresh token (revoked, expired, the client changed) can only be fixed by connecting again
      if (error instanceof GoogleProblem && (error.code === 'invalid' || error.code === 'unauthorized')) { throw new GoogleProblem('expired', 'Google no longer accepts this connection; connect your calendar again.', { cause: error }); }
      throw error;
    }
  }

  async revoke(token: string): Promise<void> {
    await this.#form(this.#endpoints.revoke, { token });
  }

  async account(accessToken: string): Promise<Account> {
    return Account.parse(await this.#json('GET', this.#endpoints.userinfo, accessToken));
  }

  async calendars(accessToken: string): Promise<GoogleCalendarEntry[]> {
    const page = z.object({ items: z.array(GoogleCalendarEntry).default([]) }).parse(await this.#json('GET', `${this.#endpoints.calendar}/users/me/calendarList?maxResults=250`, accessToken));
    return page.items;
  }

  async events(accessToken: string, calendar: string, query: EventQuery): Promise<{ items: GoogleEvent[]; more: boolean }> {
    const url = new URL(`${this.#endpoints.calendar}/calendars/${encodeURIComponent(calendar)}/events`);
    const params = { timeMin: query.timeMin, timeMax: query.timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(query.maxResults), ...(query.q === undefined ? {} : { q: query.q }) };
    for (const [key, value] of Object.entries(params)) { url.searchParams.set(key, value); }
    const page = EventPage.parse(await this.#json('GET', url.href, accessToken));
    return { items: page.items, more: page.nextPageToken !== undefined };
  }

  async event(accessToken: string, calendar: string, id: string): Promise<GoogleEvent> {
    return GoogleEvent.parse(await this.#json('GET', this.#eventUrl(calendar, id), accessToken));
  }

  async insert(accessToken: string, calendar: string, event: EventWrite): Promise<GoogleEvent> {
    return GoogleEvent.parse(await this.#json('POST', `${this.#endpoints.calendar}/calendars/${encodeURIComponent(calendar)}/events?sendUpdates=all`, accessToken, event));
  }

  async patch(accessToken: string, calendar: string, id: string, changes: EventWrite): Promise<GoogleEvent> {
    return GoogleEvent.parse(await this.#json('PATCH', `${this.#eventUrl(calendar, id)}?sendUpdates=all`, accessToken, changes));
  }

  async remove(accessToken: string, calendar: string, id: string): Promise<void> {
    await this.#json('DELETE', `${this.#eventUrl(calendar, id)}?sendUpdates=all`, accessToken);
  }

  #eventUrl(calendar: string, id: string): string {
    return `${this.#endpoints.calendar}/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`;
  }

  #form(url: string, fields: Record<string, string>): Promise<unknown> {
    return this.#send(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  }

  #json(method: string, url: string, accessToken: string, body?: unknown): Promise<unknown> {
    return this.#send(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async #send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(this.#timeout) });
    } catch (error) {
      throw new GoogleProblem('network', `Couldn't reach Google: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) { throw problemFor(response.status, text); }
    if (text.trim() === '') { return {}; }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch (error) {
      throw new GoogleProblem('garbled', 'Google answered with something that is not JSON.', { cause: error });
    }
  }
}
