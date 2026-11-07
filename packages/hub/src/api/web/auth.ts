/**
 * The sign-in slice, and the plugin that binds the web API's shared middleware: request telemetry (`tel`, with
 * `@ayepi/otel`) and the signed-in user (`hubAuth`, a bearer JWT checked against its sign-in session on every call).
 * Sign-in attempts are rate limited per email with `@ayepi/rate` on the hub's database.
 */
import { bearerAuth } from '@ayepi/auth/server';
import { reject } from '@ayepi/core';
import { telemetry } from '@ayepi/otel/server';
import { plugin } from '@ayepi/plugin';
import { limiter } from '@ayepi/rate';
import { AccessClaims, hubAuth, tel } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { ACCESS_TOKEN, normalEmail } from '../auth.ts';
import { deviceOf, type FullHandlers } from './access.ts';
import { authSlice } from './slices.ts';

/** What the sign-in plugin needs besides the services. */
export interface AuthPluginOptions {
  /** The JWT secret. */
  readonly secret: string;
}

/** The sign-in plugin. Install it first: it binds `tel` and `hubAuth` for every other slice. */
export function authPlugin(hub: HubServices, options: AuthPluginOptions) {
  const { authEnv } = hub.settings;
  const signIns = limiter({
    limit: authEnv.HARNESS_SIGN_IN_LIMIT, window: authEnv.HARNESS_SIGN_IN_WINDOW, algorithm: 'sliding-window', store: hub.store.ports.rate, prefix: 'sign-in',
  });
  return plugin({ name: 'web.auth', spec: authSlice })
    .middleware(telemetry.server(tel, {
      logger: hub.log, logWith: (add, inner) => hub.log.logWith(add, inner), echoRequestId: true, now: hub.clock,
      overrides: { presence: { request: false, response: false } },
    }))
    .middleware(bearerAuth.server(hubAuth, {
      secret: options.secret, claims: AccessClaims, expiresIn: Math.floor(authEnv.HARNESS_ACCESS_TTL / 1000), ...ACCESS_TOKEN,
      toUser: (claims) => hub.api.auth.user(claims),
    }))
    .handlers((): FullHandlers<typeof authSlice> => ({
      setup: () => hub.api.auth.setup(),
      createAdmin: async ({ data, req }) => {
        const tokens = await hub.api.auth.createAdmin({ ...data, device: deviceOf(req) });
        if (tokens === undefined) { throw reject(409, 'ADMIN_EXISTS', 'the admin account already exists'); }
        hub.log.info('auth.admin.created', { user: tokens.user.id });
        return tokens;
      },
      signIn: async ({ data, req, fail }) => {
        const key = normalEmail(data.email);
        const allowed = await signIns.check(key, { now: hub.clock() });
        if (!allowed.allowed) { throw reject(429, 'TOO_MANY_SIGN_INS', `try again in ${Math.ceil(allowed.retryAfter / 1000)} s`); }
        const tokens = await hub.api.auth.signIn({ ...data, device: deviceOf(req) });
        if (tokens === undefined) {
          hub.log.warn('auth.sign-in.refused', { remaining: allowed.remaining });
          return fail(401, { reason: 'That email and password don’t match.' });
        }
        await signIns.reset(key);
        hub.log.info('auth.signed-in', { user: tokens.user.id });
        return tokens;
      },
      refresh: async ({ data }) => {
        const tokens = await hub.api.auth.refresh(data.refresh);
        if (tokens === undefined) { throw reject(401, 'REFRESH_REFUSED', 'sign in again'); }
        return tokens;
      },
      signOut: async ({ jwt, user }) => {
        await hub.api.auth.signOut(jwt);
        hub.log.info('auth.signed-out', { user: user.id });
      },
      me: ({ user }) => user,
    }));
}
