// Live: the real Google APIs with a personal OAuth client and a refresh token for a test account (skipped, with the
// reason, unless GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are set). It only reads: a token
// refresh, the account, its calendars and the next week of the primary calendar. Run with `npm run test:live`.
import { env } from '@ayepi/env';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FetchGoogleApi } from './google.ts';

const keys = env({
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REFRESH_TOKEN: z.string().min(1).optional(),
}).parse();
const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: refreshToken } = keys;

describe.skipIf(clientId === undefined || clientSecret === undefined || refreshToken === undefined)('Google Calendar (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)', () => {
  it('refreshes the token and reads the account, its calendars and the next week', async () => {
    const google = new FetchGoogleApi({ fetch: (input, init) => fetch(input, init), timeout: 20_000 });
    const tokens = await google.refresh({ clientId: clientId ?? '', clientSecret: clientSecret ?? '' }, refreshToken ?? '');
    expect(tokens.access_token.length).toBeGreaterThan(10);
    expect((await google.account(tokens.access_token)).email).toContain('@');
    expect((await google.calendars(tokens.access_token)).some((calendar) => calendar.primary === true)).toBe(true);
    const now = Date.now();
    const page = await google.events(tokens.access_token, 'primary', { timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86_400_000).toISOString(), maxResults: 5 });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
