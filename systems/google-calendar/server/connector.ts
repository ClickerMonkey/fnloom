/**
 * Connecting a person's Google account, as the hub's connect flow asks (`connectStart`, `connectFinish`,
 * `disconnect`): the consent URL with the hub's signed `state`, the code from the redirect traded for tokens and the
 * account's email, and the refresh token revoked when the person disconnects.
 */
import { Json, type ConnectFinish, type ConnectResult, type ConnectStart, type RunConnection } from '@harness/core';
import { Credentials, credentialsOf } from './calendar.ts';
import { GoogleProblem, type GoogleApi, type OAuthClient } from './google.ts';

/** The connect flow over a `GoogleApi`. */
export class CalendarConnector {
  readonly #api: GoogleApi;
  readonly #now: () => number;

  constructor(api: GoogleApi, now: () => number) {
    this.#api = api;
    this.#now = now;
  }

  /** Where to send the person: Google's consent page, coming back to the hub's redirect with `state`. */
  start(client: OAuthClient, request: ConnectStart): { url: string } {
    return { url: this.#api.authUrl(client, request.redirect, request.state) };
  }

  /** The account and tokens for the code the redirect brought, or the problem in words. */
  async finish(client: OAuthClient, request: ConnectFinish): Promise<ConnectResult> {
    if (!('params' in request.answer)) { return { problem: 'Google Calendar connects through Google\'s page, not a form.' }; }
    const { error, code } = request.answer.params;
    if (error !== undefined) { return { problem: error === 'access_denied' ? 'You didn\'t allow access to your calendar.' : `Google said: ${error}.` }; }
    if (code === undefined || code === '') { return { problem: 'Google sent no code back; try connecting again.' }; }
    try {
      const tokens = await this.#api.exchange(client, code, request.redirect);
      if (tokens.refresh_token === undefined) { return { problem: 'Google didn\'t grant lasting access; remove the app at myaccount.google.com/permissions and connect again.' }; }
      const account = await this.#api.account(tokens.access_token);
      const credentials = credentialsOf(tokens, this.#now(), tokens.refresh_token);
      return { account: { label: account.email, ...(account.name === undefined ? {} : { detail: account.name }) }, credentials: Json.parse(credentials), expiresAt: credentials.expiresAt };
    } catch (error) {
      if (error instanceof GoogleProblem) { return { problem: error.message }; }
      throw error;
    }
  }

  /** Revoke the connection's refresh token at Google (best effort: a token already gone is fine). */
  async disconnect(connection: Pick<RunConnection, 'credentials'>): Promise<boolean> {
    const credentials = Credentials.safeParse(connection.credentials);
    if (!credentials.success) { return false; }
    try {
      await this.#api.revoke(credentials.data.refreshToken);
      return true;
    } catch (error) {
      if (error instanceof GoogleProblem) { return false; }
      throw error;
    }
  }
}
