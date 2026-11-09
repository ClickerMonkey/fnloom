/**
 * Google Calendar over the SDK's real link runtime and an in-memory hub, against the fake Google: the connect flow
 * (consent URL, code for tokens and account, revoke), every fn acting as the run's connection, tokens refreshed when
 * Google refuses them (and handed back to the hub), an expired connection reported, and the real `FetchGoogleApi`'s
 * requests and problems over a scripted `fetch`.
 */
import { readFileSync } from 'node:fs';
import { ConnectDecl, SystemPackageManifest, mintId, type ConnectionUpdate, type Json, type OutcomeWire, type RunConnection } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub, TEST_USER } from '@harness/sdk/server/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CALENDAR_CONNECT, googleCalendar } from '../shared/index.ts';
import { endAfter, eventOf, instantOf, timeOf } from './calendar.ts';
import { calendarEnv } from './env.ts';
import { FAKE_ACCOUNT, FakeGoogleApi } from './fake.ts';
import { FetchGoogleApi, GoogleProblem, type GoogleEndpoints } from './google.ts';
import { createCalendarImpl, type CalendarServer } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));
const CONFIG = { clientId: 'client-1', clientSecret: 'shh', hubUrl: 'https://hub.example' };
const REDIRECT = 'https://hub.example/connect/callback';
const NOW = Date.parse('2026-11-08T12:00:00Z');

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

describe('google-calendar over the link', () => {
  let running: RunningSystem<'google-calendar'> | undefined;
  let hub: FakeHub;
  let google: FakeGoogleApi;
  let server: CalendarServer;
  let connection: RunConnection | undefined;
  let updates: ConnectionUpdate[];

  /** Connect the fake account the way the hub's flow does, and keep the connection runs act as. */
  async function connect(settings: Json = {}): Promise<RunConnection> {
    const id = mintId('connection');
    const started = server.connect.start(CONFIG, { connection: id, owner: TEST_USER.id, redirect: REDIRECT, state: 'signed-state' });
    expect(new URL(started.url).searchParams.get('state')).toBe('signed-state');
    const result = await server.connect.finish(CONFIG, { connection: id, owner: TEST_USER.id, redirect: REDIRECT, answer: { params: { code: 'good-code', state: 'signed-state' } } });
    if (!('credentials' in result)) { throw new Error(result.problem); }
    expect(result.account).toEqual({ label: FAKE_ACCOUNT.email, detail: FAKE_ACCOUNT.name });
    connection = { id, owner: TEST_USER.id, credentials: result.credentials, settings };
    return connection;
  }

  beforeEach(async () => {
    google = new FakeGoogleApi();
    updates = [];
    connection = undefined;
    server = createCalendarImpl({
      settings: calendarEnv.parse(),
      api: google,
      connections: {
        of: () => connection,
        update: (update) => {
          updates.push(update);
          if (connection !== undefined && 'credentials' in update.update) { connection = { ...connection, credentials: update.update.credentials }; }
          return Promise.resolve();
        },
      },
      now: () => NOW,
    });
    hub = new FakeHub({ config: CONFIG });
    running = await serve(googleCalendar, server.impl, { hub: 'ws://hub.test/link', state: 'unused', version: packageManifest.version }, hub.host());
    await running.ready();
  });
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('is named as system.json says; its connect declaration covers every fn, deleting off by default', () => {
    expect(googleCalendar.name).toBe(packageManifest.name);
    expect(ConnectDecl.parse(CALENDAR_CONNECT).fns).toMatchObject({ list_events: { on: true, ask: false }, create_event: { on: true, ask: true }, delete_event: { on: false } });
    expect(Object.keys(CALENDAR_CONNECT.fns).sort()).toEqual(hub.manifests[0]?.fns.map((f) => f.name).sort());
  });

  it('fails every fn plainly without a connection', async () => {
    expect(await hub.run('google-calendar/list_events', {})).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'not-connected' } });
  });

  it('creates, lists, searches, reads, changes and deletes events as the person', async () => {
    await connect({ calendars: ['primary', 'work'] });
    const made = done(await hub.run('google-calendar/create_event', { title: 'Dentist', start: '2026-11-09T09:00:00-05:00', location: 'Main St', attendees: ['sam@example.com'] }));
    expect(made).toMatchObject({ title: 'Dentist', calendar: 'primary', allDay: false, start: '2026-11-09T09:00:00-05:00', end: '2026-11-09T15:00:00.000Z', attendees: ['sam@example.com'] });
    done(await hub.run('google-calendar/create_event', { title: 'Offsite', start: '2026-11-10', calendar: 'work' }));
    expect(google.stored.get('work')?.[0]).toMatchObject({ start: { date: '2026-11-10' }, end: { date: '2026-11-11' } });

    const listed = done(await hub.run('google-calendar/list_events', {}));
    expect(listed).toMatchObject({ events: [{ title: 'Dentist' }, { title: 'Offsite', calendar: 'work', allDay: true }], more: false });
    expect(done(await hub.run('google-calendar/list_events', { limit: 1 }))).toMatchObject({ events: [{ title: 'Dentist' }], more: true });
    expect(done(await hub.run('google-calendar/search_events', { query: 'dentist' }))).toMatchObject({ events: [{ title: 'Dentist' }] });
    expect(google.calls).toContain('events work q=dentist');

    const { id } = z.object({ id: z.string() }).parse(made);
    expect(done(await hub.run('google-calendar/update_event', { id, title: 'Dentist (moved)', start: '2026-11-09T10:00:00-05:00' }))).toMatchObject({ title: 'Dentist (moved)', start: '2026-11-09T10:00:00-05:00', location: 'Main St' });
    expect(done(await hub.run('google-calendar/get_event', { id }))).toMatchObject({ title: 'Dentist (moved)' });
    expect(done(await hub.run('google-calendar/delete_event', { id }))).toEqual({ deleted: true, title: 'Dentist (moved)' });
    expect(await hub.run('google-calendar/get_event', { id })).toMatchObject({ status: 'failed', error: { class: 'caller', code: 'not-found' } });
  });

  it('refuses times that are not times, and a mixed all-day range', async () => {
    await connect();
    expect(await hub.run('google-calendar/create_event', { title: 'x', start: 'tomorrow' })).toMatchObject({ status: 'invalid-input', invalid: { problems: [{ path: 'start' }] } });
    expect(await hub.run('google-calendar/create_event', { title: 'x', start: '2026-11-09', end: '2026-11-09T10:00:00Z' })).toMatchObject({ status: 'invalid-input' });
    expect(await hub.run('google-calendar/list_events', { from: 'soon' })).toMatchObject({ status: 'invalid-input' });
  });

  it('refreshes a refused token once and hands the new one to the hub; reports a connection Google gave up on', async () => {
    const connected = await connect();
    const token = z.object({ accessToken: z.string() }).parse(connected.credentials).accessToken;
    google.expire(token);
    expect(await hub.run('google-calendar/list_events', {})).toMatchObject({ status: 'done' });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({ credentials: { refreshToken: 'refresh-1' } });

    google.refreshTokens.clear();
    google.live.clear();
    expect(await hub.run('google-calendar/list_events', {})).toMatchObject({ status: 'failed', error: { class: 'fatal', code: 'reconnect' } });
    expect(JSON.stringify(updates.at(-1)?.update)).toContain('connect your calendar again');
  });

  it('says what went wrong connecting, and revokes on disconnect', async () => {
    const id = mintId('connection');
    const ask = (params: Record<string, string>) => server.connect.finish(CONFIG, { connection: id, owner: TEST_USER.id, redirect: REDIRECT, answer: { params } });
    expect(await ask({ error: 'access_denied' })).toEqual({ problem: 'You didn\'t allow access to your calendar.' });
    expect(await ask({})).toHaveProperty('problem');
    expect(await ask({ code: 'bad' })).toEqual({ problem: 'Bad code.' });
    google.grantRefresh = false;
    expect(await ask({ code: 'good-code' })).toHaveProperty('problem');
    expect(await server.connect.finish(CONFIG, { connection: id, owner: TEST_USER.id, redirect: REDIRECT, answer: { form: {} } })).toHaveProperty('problem');
    google.grantRefresh = true;
    const connected = await connect();
    expect(await server.connect.disconnect(connected)).toBe(true);
    expect(google.refreshTokens.size).toBe(0);
    expect(await server.connect.disconnect({ credentials: null })).toBe(false);
  });
});

describe('calendar helpers', () => {
  it('reads times as Google takes them', () => {
    expect(timeOf('2026-11-08', 'UTC')).toEqual({ date: '2026-11-08' });
    expect(timeOf('2026-11-08T09:00:00-05:00', 'America/New_York')).toEqual({ dateTime: '2026-11-08T09:00:00-05:00', timeZone: 'America/New_York' });
    expect(timeOf('nope', 'UTC')).toBeUndefined();
    expect(endAfter({ date: '2026-12-31' })).toEqual({ date: '2027-01-01' });
    // a time without an offset is the person's wall clock: the hour is added to it, whatever this machine's zone
    expect(endAfter({ dateTime: '2026-11-08T23:30:00', timeZone: 'America/New_York' })).toEqual({ dateTime: '2026-11-09T00:30:00.000', timeZone: 'America/New_York' });
    expect(endAfter({ dateTime: '2026-11-08T09:00:00-05:00', timeZone: 'America/New_York' })).toEqual({ dateTime: '2026-11-08T15:00:00.000Z', timeZone: 'America/New_York' });
    expect(instantOf('2026-11-08')).toBe('2026-11-08T00:00:00.000Z');
    expect(eventOf({ id: 'e', start: { date: '2026-11-08' }, end: { date: '2026-11-09' } }, 'primary')).toMatchObject({ title: '(no title)', allDay: true, attendees: [] });
  });
});

describe('FetchGoogleApi', () => {
  const endpoints: GoogleEndpoints = { auth: 'https://g.test/auth', token: 'https://g.test/token', revoke: 'https://g.test/revoke', userinfo: 'https://g.test/me', calendar: 'https://g.test/cal' };
  function api(answer: (url: string, init: RequestInit) => Response) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, init: init ?? {} });
      return Promise.resolve(answer(url, init ?? {}));
    };
    return { google: new FetchGoogleApi({ fetch: fetchFn, endpoints, timeout: 1_000 }), seen };
  }
  const client = { clientId: 'id', clientSecret: 'secret' };

  it('asks for offline consent with the scopes, and trades a code with the client', async () => {
    const { google, seen } = api(() => Response.json({ access_token: 'a', expires_in: 60, refresh_token: 'r' }));
    const url = new URL(google.authUrl(client, REDIRECT, 'st'));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'id', redirect_uri: REDIRECT, access_type: 'offline', prompt: 'consent', state: 'st', response_type: 'code' });
    expect(url.searchParams.get('scope')).toContain('calendar.events');
    expect(await google.exchange(client, 'c', REDIRECT)).toMatchObject({ access_token: 'a', refresh_token: 'r' });
    expect(seen[0]?.init.body).toContain('grant_type=authorization_code');
  });

  it('sends the bearer token, encodes ids, and reads pages of events', async () => {
    const { google, seen } = api(() => Response.json({ items: [{ id: 'e1', summary: 'A' }], nextPageToken: 'n' }));
    expect(await google.events('tok', 'me@example.com', { timeMin: '2026-01-01T00:00:00Z', timeMax: '2026-02-01T00:00:00Z', maxResults: 5, q: 'x' })).toEqual({ items: [{ id: 'e1', summary: 'A' }], more: true });
    expect(seen[0]?.url).toContain('/calendars/me%40example.com/events?');
    expect(new Headers(seen[0]?.init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('turns statuses into problems, and a refused refresh into expired', async () => {
    const statuses = [401, 403, 404, 429, 500, 400];
    const codes: string[] = [];
    for (const status of statuses) {
      const { google } = api(() => new Response('{"error":"x"}', { status }));
      try { await google.account('t'); } catch (error) { if (error instanceof GoogleProblem) { codes.push(error.code); } }
    }
    expect(codes).toEqual(['unauthorized', 'forbidden', 'not-found', 'busy', 'busy', 'invalid']);
    const refused = api(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(refused.google.refresh(client, 'r')).rejects.toMatchObject({ code: 'expired' });
    const garbled = api(() => new Response('<html>', { status: 200 }));
    await expect(garbled.google.calendars('t')).rejects.toMatchObject({ code: 'garbled' });
    const empty = api(() => new Response(null, { status: 204 }));
    await expect(empty.google.remove('t', 'primary', 'e')).resolves.toBeUndefined();
  });
});
