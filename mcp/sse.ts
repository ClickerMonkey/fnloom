/**
 * The older HTTP + SSE transport (MCP 2024-11-05), served over web-standard `Request`/`Response`:
 *
 * - `GET /sse` opens an event stream. Its first event is `endpoint`, whose data is the URL to POST messages to
 *   (`/messages?sessionId=…`). Every response and notification for the session then arrives as `message` events.
 * - `POST /messages?sessionId=…` takes one JSON-RPC message, answers `202`, and sends the response over the stream.
 *
 * `@ayepi/mcp` has the client for this transport (`McpSseClientTransport`) but no server, so it is written here on
 * top of the same `McpServer.handle` the Streamable HTTP transport uses. A session belongs to the subject that
 * opened it: another subject's `POST` gets `404`, as the library's own transport answers.
 */
import { randomUUID } from 'node:crypto';
import type { McpAuthInfo, McpAuthorizer, McpServer } from '@ayepi/mcp';
import { admit } from './auth.ts';

interface Session {
  readonly id: string;
  readonly auth: McpAuthInfo | undefined;
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  keepAlive: ReturnType<typeof setInterval> | undefined;
}

const encoder = new TextEncoder();
const KEEP_ALIVE_MS = 15_000;

/** The `/sse` and `/messages` routes over one `McpServer`, guarded by `authorizer` (undefined: open). */
export class LegacySseTransport {
  readonly #server: McpServer;
  readonly #authorizer: McpAuthorizer | undefined;
  readonly #sessions = new Map<string, Session>();

  constructor(server: McpServer, authorizer: McpAuthorizer | undefined) {
    this.#server = server;
    this.#authorizer = authorizer;
    server.onNotification((message, session) => {
      for (const target of this.#sessions.values()) {
        if (session === undefined || target.id === session) { this.#send(target, 'message', JSON.stringify(message)); }
      }
    });
  }

  /** Answers `/sse` and `/messages`; `undefined` for any other path. */
  async route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === '/sse' && request.method === 'GET') { return this.#open(request); }
    if (url.pathname === '/messages' && request.method === 'POST') { return this.#post(request, url); }
    return undefined;
  }

  /** Ends every session and its stream. */
  close(): void {
    for (const session of [...this.#sessions.values()]) { this.#end(session); }
    this.#server.close();
  }

  async #open(request: Request): Promise<Response> {
    const admission = await admit(this.#authorizer, request);
    if (!admission.ok) { return admission.response; }
    const session: Session = { id: randomUUID(), auth: admission.auth, controller: undefined, keepAlive: undefined };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        session.controller = controller;
        this.#sessions.set(session.id, session);
        controller.enqueue(encoder.encode(`event: endpoint\ndata: /messages?sessionId=${session.id}\n\n`));
        session.keepAlive = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), KEEP_ALIVE_MS);
      },
      cancel: () => {
        this.#end(session);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  }

  async #post(request: Request, url: URL): Promise<Response> {
    const session = this.#sessions.get(url.searchParams.get('sessionId') ?? '');
    const admission = await admit(this.#authorizer, request);
    if (!admission.ok) { return admission.response; }
    if (session === undefined || session.auth?.subject !== admission.auth?.subject) {
      return jsonError(404, -32001, 'no such session');
    }
    let message: unknown;
    try {
      message = JSON.parse(await request.text());
    } catch {
      return jsonError(400, -32700, 'parse error');
    }
    const response = await this.#server.handle(message, { session: session.id, auth: session.auth, signal: request.signal });
    if (response !== null) { this.#send(session, 'message', JSON.stringify(response)); }
    return new Response(null, { status: 202 });
  }

  #send(session: Session, event: string, data: string): void {
    session.controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
  }

  #end(session: Session): void {
    if (session.keepAlive !== undefined) { clearInterval(session.keepAlive); }
    session.keepAlive = undefined;
    try { session.controller?.close(); } catch { /* already closed by the client going away */ }
    session.controller = undefined;
    this.#sessions.delete(session.id);
    this.#server.endSession(session.id);
  }
}

function jsonError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
}
