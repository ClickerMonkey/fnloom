/**
 * A fake Google for tests: one account, its calendars and events in memory, codes and tokens it issued (an access
 * token can be made to expire, a refresh token revoked), and every call recorded. Used by the `*.test.ts` files only.
 */
import { GoogleProblem, type Account, type EventQuery, type EventWrite, type GoogleApi, type GoogleCalendarEntry, type GoogleEvent, type OAuthClient, type TokenAnswer } from './google.ts';

/** The fake account's email. */
export const FAKE_ACCOUNT: Account = { email: 'tess@example.com', name: 'Tess Tester' };

/** `GoogleApi` in memory. */
export class FakeGoogleApi implements GoogleApi {
  readonly calls: string[] = [];
  readonly stored = new Map<string, GoogleEvent[]>([['primary', []], ['work', []]]);
  readonly live = new Set<string>();
  readonly refreshTokens = new Set<string>();
  /** Whether the code exchange grants a refresh token. */
  grantRefresh = true;
  #issued = 0;
  #ids = 0;

  authUrl(client: OAuthClient, redirect: string, state: string): string {
    return `https://accounts.example/auth?client_id=${client.clientId}&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  }

  exchange(_client: OAuthClient, code: string): Promise<TokenAnswer> {
    this.calls.push(`exchange ${code}`);
    if (code !== 'good-code') { return Promise.reject(new GoogleProblem('invalid', 'Bad code.')); }
    const refresh = `refresh-${(this.#issued += 1)}`;
    if (this.grantRefresh) { this.refreshTokens.add(refresh); }
    return Promise.resolve({ ...this.#access(), ...(this.grantRefresh ? { refresh_token: refresh } : {}) });
  }

  refresh(_client: OAuthClient, refreshToken: string): Promise<TokenAnswer> {
    this.calls.push('refresh');
    if (!this.refreshTokens.has(refreshToken)) { return Promise.reject(new GoogleProblem('expired', 'Google no longer accepts this connection; connect your calendar again.')); }
    return Promise.resolve(this.#access());
  }

  revoke(token: string): Promise<void> {
    this.calls.push(`revoke ${token}`);
    this.refreshTokens.delete(token);
    return Promise.resolve();
  }

  account(accessToken: string): Promise<Account> {
    return this.#authorized(accessToken, () => FAKE_ACCOUNT);
  }

  calendars(accessToken: string): Promise<GoogleCalendarEntry[]> {
    return this.#authorized(accessToken, () => [{ id: 'primary', summary: FAKE_ACCOUNT.email, primary: true }, { id: 'work', summary: 'Work' }]);
  }

  events(accessToken: string, calendar: string, query: EventQuery): Promise<{ items: GoogleEvent[]; more: boolean }> {
    return this.#authorized(accessToken, () => {
      this.calls.push(`events ${calendar}${query.q === undefined ? '' : ` q=${query.q}`}`);
      const min = Date.parse(query.timeMin);
      const max = Date.parse(query.timeMax);
      const matching = this.#calendar(calendar)
        .filter((event) => { const at = Date.parse(event.start?.dateTime ?? event.start?.date ?? ''); return at >= min && at < max; })
        .filter((event) => query.q === undefined || JSON.stringify(event).toLowerCase().includes(query.q.toLowerCase()))
        .sort((a, b) => Date.parse(a.start?.dateTime ?? a.start?.date ?? '') - Date.parse(b.start?.dateTime ?? b.start?.date ?? ''));
      return { items: matching.slice(0, query.maxResults), more: matching.length > query.maxResults };
    });
  }

  event(accessToken: string, calendar: string, id: string): Promise<GoogleEvent> {
    return this.#authorized(accessToken, () => this.#find(calendar, id));
  }

  insert(accessToken: string, calendar: string, event: EventWrite): Promise<GoogleEvent> {
    return this.#authorized(accessToken, () => {
      this.calls.push(`insert ${calendar}`);
      const made: GoogleEvent = { ...event, id: `evt${(this.#ids += 1)}`, status: 'confirmed', htmlLink: 'https://calendar.example/e', organizer: { email: FAKE_ACCOUNT.email } };
      this.#calendar(calendar).push(made);
      return made;
    });
  }

  patch(accessToken: string, calendar: string, id: string, changes: EventWrite): Promise<GoogleEvent> {
    return this.#authorized(accessToken, () => {
      this.calls.push(`patch ${calendar} ${id}`);
      const found = this.#find(calendar, id);
      Object.assign(found, changes);
      return found;
    });
  }

  remove(accessToken: string, calendar: string, id: string): Promise<void> {
    return this.#authorized(accessToken, () => {
      this.calls.push(`remove ${calendar} ${id}`);
      const found = this.#find(calendar, id);
      this.stored.set(calendar, this.#calendar(calendar).filter((event) => event !== found));
    });
  }

  /** Make an access token stop working, as an expired one does. */
  expire(accessToken: string): void {
    this.live.delete(accessToken);
  }

  #access(): TokenAnswer {
    const token = `access-${(this.#issued += 1)}`;
    this.live.add(token);
    return { access_token: token, expires_in: 3_600 };
  }

  #calendar(calendar: string): GoogleEvent[] {
    const events = this.stored.get(calendar);
    if (events === undefined) { throw new GoogleProblem('not-found', 'Google has no such event or calendar.'); }
    return events;
  }

  #find(calendar: string, id: string): GoogleEvent {
    const found = this.#calendar(calendar).find((event) => event.id === id);
    if (found === undefined) { throw new GoogleProblem('not-found', 'Google has no such event or calendar.'); }
    return found;
  }

  #authorized<T>(accessToken: string, work: () => T): Promise<T> {
    if (!this.live.has(accessToken)) { return Promise.reject(new GoogleProblem('unauthorized', 'Google refused the access token.')); }
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
