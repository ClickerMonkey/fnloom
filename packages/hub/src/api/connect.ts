/**
 * The redirect providers send a person back to after they sign in (`/connect/callback`): a plain GET outside the API,
 * answered by the connections module, then a redirect to the system's page in the web app (`/connect/<system>`), with
 * `?problem=` when connecting failed. The browser's cookies go along: the sign-in finishes only in the browser that
 * started it (`ConnectBinding`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONNECT_CALLBACK_PATH } from '../connections/service.ts';
import type { CallbackAnswer, ConnectionService } from '../connections/index.ts';
import type { FileRoute } from './serve.ts';

/** Answers `/connect/callback`. */
export class ConnectCallbackRoute implements FileRoute {
  readonly #connections: () => Pick<ConnectionService, 'callback'>;

  constructor(connections: () => Pick<ConnectionService, 'callback'>) {
    this.#connections = connections;
  }

  async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== CONNECT_CALLBACK_PATH || req.method !== 'GET') { return false; }
    const url = new URL(req.url ?? '/', 'http://hub');
    const answer = await this.#connections().callback(Object.fromEntries(url.searchParams), cookiesOf(req.headers.cookie))
      .catch((error: unknown): CallbackAnswer => ({ system: undefined, problem: error instanceof Error ? error.message : String(error) }));
    const page = answer.system === undefined ? '/' : `/connect/${encodeURIComponent(answer.system)}`;
    const location = answer.problem === undefined ? page : `${page}?${new URLSearchParams({ problem: answer.problem }).toString()}`;
    res.writeHead(302, {
      location, 'cache-control': 'no-store',
      ...(answer.clear === undefined ? {} : { 'set-cookie': `${answer.clear}=; Path=${CONNECT_CALLBACK_PATH}; Max-Age=0; HttpOnly; SameSite=Lax` }),
    }).end();
    return true;
  }
}

/** A `Cookie` header as name to value (the last of a repeated name wins). */
export function cookiesOf(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const value = part.slice(at + 1).trim();
    try { out[part.slice(0, at).trim()] = decodeURIComponent(value); } catch { out[part.slice(0, at).trim()] = value; }
  }
  return out;
}
