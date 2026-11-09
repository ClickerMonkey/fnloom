/**
 * The redirect providers send a person back to after they sign in (`/connect/callback`): a plain GET outside the API,
 * answered by the connections module, then a redirect to the system's page in the web app (`/connect/<system>`), with
 * `?problem=` when connecting failed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONNECT_CALLBACK_PATH } from '../connections/service.ts';
import type { ConnectionService } from '../connections/index.ts';
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
    const answer = await this.#connections().callback(Object.fromEntries(url.searchParams));
    const page = answer.system === undefined ? '/' : `/connect/${encodeURIComponent(answer.system)}`;
    const location = answer.problem === undefined ? page : `${page}?${new URLSearchParams({ problem: answer.problem }).toString()}`;
    res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
    return true;
  }
}
