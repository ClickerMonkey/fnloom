/**
 * The sign-in slice, and the plugin that binds the web API's shared middleware: request telemetry (`tel`, with
 * `@ayepi/otel`) and the signed-in user (`hubAuth`, a bearer JWT checked against its sign-in session on every call).
 * Password sign-ins are rate limited with `@ayepi/rate` on the hub's database, by the admin's limits (`SignInLimits`):
 * one email's tries from one address, and every try from one address. The email alone is never a key, so someone
 * guessing at an account from elsewhere can't lock its owner out; an address is where the request came from
 * (`clientAddress`: the socket's, or a trusted proxy's word; an IPv6 one counts by its /64, `limitKey`). The first admin needs the setup code (`announceSetup`),
 * and an SSO sign-in finishes by redeeming its hand-off code with this browser's hand-off cookie.
 */
import { bearerAuth } from '@ayepi/auth/server';
import { reject } from '@ayepi/core';
import { telemetry } from '@ayepi/otel/server';
import { plugin } from '@ayepi/plugin';
import { limiter, type RateLimitResult } from '@ayepi/rate';
import { authSlice, AccessClaims, hubAuth, SSO_HANDOFF_COOKIE, tel, type TryLimit } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { ACCESS_TOKEN } from '../auth.ts';
import { clientAddress, limitKey } from '../client-address.ts';
import { normalEmail, signInLimits } from '../identities.ts';
import { deviceOf, type FullHandlers } from './access.ts';
import { personViews } from './people.ts';

/** What the sign-in plugin needs besides the services. */
export interface AuthPluginOptions {
  /** The JWT secret. */
  readonly secret: string;
}

/** The sign-in plugin. Install it first: it binds `tel` and `hubAuth` for every other slice. */
export function authPlugin(hub: HubServices, options: AuthPluginOptions) {
  const { authEnv } = hub.settings;
  /** A limiter for one of the admin's limits (made per try, so a changed limit applies at once; they share the store). */
  const tries = (prefix: string, rule: TryLimit) => limiter({ ...rule, algorithm: 'sliding-window', store: hub.store.ports.rate, prefix });
  return plugin({ name: 'web.auth', spec: authSlice })
    .middleware(telemetry.server(tel, {
      logger: hub.log, logWith: (add, inner) => hub.log.logWith(add, inner), echoRequestId: true, now: hub.clock,
      response: { status: true, duration: true, error: true },
      overrides: { presence: { request: false, response: false } },
    }))
    .middleware(bearerAuth.server(hubAuth, {
      secret: options.secret, claims: AccessClaims, expiresIn: Math.floor(authEnv.HARNESS_ACCESS_TTL / 1000), ...ACCESS_TOKEN,
      toUser: (claims) => hub.api.auth.user(claims),
    }))
    .handlers((): FullHandlers<typeof authSlice> => ({
      setup: () => hub.api.auth.setup(),
      createAdmin: async ({ data, req }) => {
        if (!hub.api.auth.setupMatches(data.setup)) {
          if ((await hub.api.auth.setup()).needsAdmin) {
            hub.log.warn('auth.setup.refused', { from: await clientAddress(req, hub.store) });
            throw reject(403, 'SETUP_CODE', 'That setup code isn’t right. Find it in the hub’s log.');
          }
          throw reject(409, 'ADMIN_EXISTS', 'the admin account already exists');
        }
        const tokens = await hub.api.auth.createAdmin({ ...data, device: deviceOf(req) });
        if (tokens === undefined) { throw reject(409, 'ADMIN_EXISTS', 'the admin account already exists'); }
        hub.log.info('auth.admin.created', { user: tokens.user.id });
        return tokens;
      },
      signIn: async ({ data, req, fail }) => {
        const [limits, from] = await Promise.all([signInLimits(hub.store), clientAddress(req, hub.store)]);
        const account = tries('sign-in:account', limits.account);
        const network = limitKey(from);
        const accountKey = JSON.stringify([normalEmail(data.email), network]);
        const now = hub.clock();
        // every try counts, before the password is checked, so tries sent at once can't all slip under the limit
        const checks: RateLimitResult[] = [await tries('sign-in:address', limits.address).check(network, { now }), await account.check(accountKey, { now })];
        const refused = checks.find((check) => !check.allowed);
        if (refused !== undefined) {
          hub.log.warn('auth.sign-in.limited', { from });
          throw reject(429, 'TOO_MANY_SIGN_INS', `Too many tries. Try again in ${Math.ceil(refused.retryAfter / 1000)} s.`);
        }
        const tokens = await hub.api.auth.signIn({ ...data, device: deviceOf(req) });
        if (tokens === undefined) {
          hub.log.warn('auth.sign-in.refused', { from, remaining: Math.min(...checks.map((check) => check.remaining)) });
          return fail(401, { reason: 'That email and password don’t match.' });
        }
        await account.reset(accountKey);
        hub.log.info('auth.signed-in', { user: tokens.user.id });
        return tokens;
      },
      refresh: async ({ data }) => {
        const tokens = await hub.api.auth.refresh(data.refresh);
        if (tokens === undefined) { throw reject(401, 'REFRESH_REFUSED', 'sign in again'); }
        return tokens;
      },
      redeemSso: ({ data, cookies }) => {
        const tokens = hub.api.sso.redeem(data.code, cookies[SSO_HANDOFF_COOKIE]);
        if (tokens === undefined) { throw reject(401, 'SSO_HANDOFF_REFUSED', 'That sign-in didn’t finish here. Sign in again.'); }
        return tokens;
      },
      signOut: async ({ jwt, user }) => {
        await hub.api.auth.signOut(jwt);
        hub.log.info('auth.signed-out', { user: user.id });
      },
      me: ({ user }) => user,
      account: async ({ user }) => {
        const actor = await hub.store.table('actors').get(user.id);
        const [view] = actor === undefined ? [] : await personViews(hub, [actor]);
        if (view === undefined) throw reject(404, 'NOT_FOUND', 'no such person');
        return view;
      },
    }));
}
