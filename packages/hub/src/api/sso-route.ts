/**
 * The SSO sign-in's two plain GETs outside the API (`api/sso.ts` does the work):
 *
 * - `/auth/sso/<provider>/start?next=<path>`: the sign-in page's provider button is a link here. It sets the binding
 *   cookie (httpOnly, on the callback path, `SameSite=Lax` so the provider's redirect back carries it) and redirects to
 *   the provider. Reached at a host other than `HARNESS_URL`'s (the LAN IP, the web dev port; a proxy's
 *   `X-Forwarded-Host` counts), it first redirects to the same start on `HARNESS_URL`, `next` kept, since the provider
 *   comes back there and the cookie must be set there too.
 * - `/auth/sso/callback`: where the provider sends the person back (the same redirect the connections use for their
 *   providers, `/connect/callback`, has its own route). It clears the cookie and redirects to the sign-in page, with
 *   a one-time code in the fragment and the hand-off cookie that binds it to this browser (on the redeem endpoint's
 *   path), or `?problem=`; a test sign-in goes back to the People page.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SSO_CALLBACK_PATH } from '@harness/core';
import { cookiesOf } from './connect.ts';
import type { FileRoute } from './serve.ts';
import { SSO_COOKIE, UnknownProvider, type SsoCallbackAnswer, type SsoCookie, type SsoService } from './sso.ts';

/** `/auth/sso/<provider>/start`. */
const START = /^\/auth\/sso\/([a-z0-9][a-z0-9-]{0,31})\/start$/;

/** A `Set-Cookie` value for a cookie a start sets. */
export function setCookie(cookie: SsoCookie): string {
  return `${cookie.name}=${encodeURIComponent(cookie.value)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=Lax${cookie.secure ? '; Secure' : ''}`;
}

/** Answers the SSO start and callback. */
export class SsoRoute implements FileRoute {
  readonly #sso: () => SsoService;

  constructor(sso: () => SsoService) {
    this.#sso = sso;
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method !== 'GET') return false;
    const url = new URL(req.url ?? '/', 'http://hub');
    if (path === SSO_CALLBACK_PATH) {
      const answer = await this.#sso().callback(url.searchParams, cookiesOf(req.headers.cookie), (req.headers['user-agent'] ?? 'unknown').slice(0, 200))
        .catch((): SsoCallbackAnswer => ({ location: `/sign-in?${new URLSearchParams({ problem: 'That sign-in didn’t finish. Sign in again.' }).toString()}`, clear: SSO_COOKIE }));
      const clear = `${answer.clear}=; Path=${SSO_CALLBACK_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`;
      redirect(res, answer.location, answer.handoff !== undefined ? [clear, setCookie(answer.handoff)] : clear);
      return true;
    }
    const provider = START.exec(path)?.[1];
    if (provider === undefined) return false;
    const elsewhere = this.#sso().relocate(reachedHost(req), url);
    if (elsewhere !== undefined) {
      res.writeHead(302, { location: elsewhere, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
      return true;
    }
    try {
      const started = await this.#sso().start(provider, { next: url.searchParams.get('next') ?? undefined });
      redirect(res, started.url, setCookie(started.cookie));
    } catch (error) {
      const problem = error instanceof UnknownProvider ? 'That sign-in option isn\'t available.' : 'The sign-in provider couldn\'t be reached. Try again in a moment.';
      redirect(res, `/sign-in?${new URLSearchParams({ problem }).toString()}`, `${SSO_COOKIE}=; Path=${SSO_CALLBACK_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`);
    }
    return true;
  }
}

/** The host the browser asked for: a proxy's first `X-Forwarded-Host` (the web dev server sets it), else `Host`. */
function reachedHost(req: IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-host'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first === undefined || first === '' ? req.headers.host : first;
}

function redirect(res: ServerResponse, location: string, cookie: string | string[]): void {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'set-cookie': cookie, 'referrer-policy': 'no-referrer' }).end();
}
