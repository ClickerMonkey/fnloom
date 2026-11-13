/**
 * The api system's contract (`shared/`), after product's api kind (build 9 design §5). Each instance is one web API
 * service (config `ApiServiceConfig`: its base URL, how it signs in, its OpenAPI document), added from the browser.
 * An api fn is a gin program whose result is an `api/HttpRequest`, plus an optional program that maps the response to
 * the fn's result; it is kept in the hub as an `api/request` fn of its service (`<service>.<name>`) and runs there.
 *
 * - **The kind** `api/request` (payload `ApiFnSpec`): describing it reads the method off the program (GET and HEAD
 *   read; the others write, so policies ask first); running it materializes the request, keeps it under the base URL,
 *   signs it with the service's auth, sends it and maps the response. A program never sees a credential.
 * - **make_api** is an authoring fn (run it on the service: `on=<service>`): an agent reads the service's operations,
 *   declares the signature, writes the request (and output) programs, has them checked (GETs are sent while
 *   authoring) and saves the fn.
 * - **operations** pages the service's OpenAPI document; **test_request** sends a GET (or HEAD) to try the service.
 */
import { API_CONFIG_SECRETS, API_KIND, API_SYSTEM, ApiFnSpec, ApiServiceConfig, ConnectDecl, HttpExchange } from '@harness/core';
import { context, fn, g, ginAs, hub, kind, system, type, wireType } from '@harness/sdk';
import { authoredFn } from '@harness/sdk/server';
import { z } from 'zod';
import { HttpBody, HttpHeader, HttpParam, HttpPart, HttpRequest, HttpResponse } from './http.ts';

export * from './http.ts';

/** An api fn's payload, as gin (`ApiFnSpec`'s type). */
export const ApiPayload = ginAs(ApiFnSpec);

/** One operation of the service's OpenAPI document. */
export const ApiOperation = z.object({ method: z.string(), path: z.string(), summary: z.string(), operationId: z.string().optional() });
export type ApiOperation = z.infer<typeof ApiOperation>;

/** A page of operations. */
export const OperationsPage = z.object({ items: z.array(ApiOperation), total: z.number().int().min(0), next: z.number().int().min(0).optional() });
export type OperationsPage = z.infer<typeof OperationsPage>;

/** The named types programs build and read, in dependency order (the authoring agent offers them in this order). */
export const HTTP_TYPES = ['HttpHeader', 'HttpParam', 'HttpPart', 'HttpBody', 'HttpRequest', 'HttpResponse'] as const;

const display = (label: string, plural: string) => ({ label, plural, icon: 'globe', color: '#4f7cac' });

const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: active, many: active },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** How callers of `make_api` use it. */
const MAKE_USAGE = [
  'Use it when the person wants something from a web API service that has no fn yet: it writes the request as a fn of the service and saves it.',
  'Run it on the service with on=<service>. Describe the request in `request`: the operation (method and path when known), the args, what the result should hold, and an example.',
  'It reuses an api fn that already does it. Call the saved fn afterwards by its name with the args its signature shows; a request that changes something waits for approval.',
].join(' ');

/** The contract's declarations, before its `connect` (which names these fns). */
const declared = system(API_SYSTEM, {
  description: 'Web API services, one per instance: each signs in its own way, and the requests asked for are kept as fns of the service.',
  groups: [{ name: 'requests', title: 'Requests', description: 'Write a request to a service as a fn, read its operations, and try a GET.' }],
  // the hub seals each: the token and client secret as text, the header values whole
  configSecrets: [...API_CONFIG_SECRETS],
  // the authoring agent is a model; api fns are hub fns it searches, reads and saves; requests go to the configured
  // service, whose host is only known from the config (reviewed when an admin adds the service)
  grants: { hub: ['ai', 'fns', 'search', 'connections'], calls: [hub.fns.fn_get.name, hub.fns.save_fn.name], network: ['*'] },
})
  .with({
    config: ginAs(ApiServiceConfig),
    types: {
      HttpHeader: type({ description: 'One request header; order is kept and a name may repeat.', shape: ginAs(HttpHeader), display: display('Header', 'Headers') }),
      HttpParam: type({
        description: 'One query or form parameter; order is kept and a name may repeat (?tag=a&tag=b). style and explode (OpenAPI 3.1) spell a list or obj value; leave them out for repeated keys.',
        shape: ginAs(HttpParam), display: display('Param', 'Params'),
      }),
      HttpPart: type({ description: 'One multipart/form-data part: a text value, or a resource whose bytes are sent.', shape: ginAs(HttpPart), display: display('Part', 'Parts') }),
      HttpBody: type({ description: 'The request body. Set exactly one slot: the slot set is the wire encoding.', shape: ginAs(HttpBody), display: display('Body', 'Bodies') }),
      HttpRequest: type({
        description: 'One outbound request: an api fn\'s request program gives one. Its url is relative to the service\'s base URL; a credential is never part of it.',
        shape: ginAs(HttpRequest), display: { ...display('Request', 'Requests'), title: 'url', subtitle: 'method' },
      }),
      HttpResponse: type({ description: 'The response an output program reads as `response`: the status, the headers and the body.', shape: ginAs(HttpResponse), display: display('Response', 'Responses') }),
    },
    kinds: {
      request: kind({
        description: 'An api fn: a request program (giving an api/HttpRequest) sent to its service, and an optional output program over the response.',
        applicability: 'Something read from or done on a web API service the person will ask for again, written by api/make_api.',
        payload: ApiPayload,
        // make_api keeps every fn it writes; a request that changes something asks by its mode on every run
        approveChanges: false,
        status: status('Calling {fn}…', 'Called {fn}', 'Calling {fn} failed'),
      }),
    },
    fns: {
      make_api: fn({
        group: 'requests',
        description: 'Write a request to this service as an api fn (or reuse one that does it) and save it.',
        instructions: MAKE_USAGE,
        args: g.obj({ request: g.field(g.text({ minLength: 1 }), { docs: 'What the request does: the operation, its args, what the result holds, and an example.' }) }),
        returns: authoredFn,
        deps: { getFn: hub.fns.fn_get, saveFn: hub.fns.save_fn },
        examples: [
          { args: { request: 'The open issues of a repository: GET /repos/{owner}/{repo}/issues?state=open; args owner and repo; give each issue\'s number and title.' }, note: 'A GET, tried while it is written.' },
          { args: { request: 'Create an issue: POST /repos/{owner}/{repo}/issues with a JSON body of title and body; give the new issue\'s number.' }, note: 'A write: it is checked but not sent while written, and asks on every run.' },
        ],
        status: status('Writing a request…', 'Wrote {output.fn}', 'Writing a request failed'),
        effects: { mode: 'write', free: false, registry: [{ thing: 'fns', action: 'create', kind: API_KIND }] },
        tags: ['api', 'write'],
      }),
      operations: fn({
        group: 'requests',
        description: 'The operations of this service\'s OpenAPI document: method, path and summary, a page at a time.',
        instructions: 'Narrow with `text` (words of the path or summary). Page with `offset` set to `next`.',
        args: g.obj({ text: g.optional(g.text()), offset: g.optional(g.num({ min: 0, whole: true })), limit: g.optional(g.num({ min: 1, max: 100, whole: true })) }),
        returns: ginAs(OperationsPage),
        examples: [{ args: { text: 'issues', limit: 10 } }],
        status: status('Reading the operations…', 'Read the operations', 'Reading the operations failed'),
        effects: { mode: 'read', free: true },
        tags: ['api', 'read'],
      }),
      test_request: fn({
        group: 'requests',
        description: 'Send one GET (or HEAD) to this service and show the exchange, with credentials masked.',
        instructions: 'Use it to see what an endpoint gives before writing an api fn. The url is relative to the service\'s base URL.',
        args: g.obj({
          method: g.optional(g.enum(['GET', 'HEAD'])),
          url: g.text(),
          params: g.optional(g.list(ginAs(HttpParam))),
          headers: g.optional(g.list(ginAs(HttpHeader))),
        }),
        returns: ginAs(HttpExchange),
        examples: [{ args: { url: '/repos/acme/web/issues', params: [{ key: 'state', value: 'open' }] } }],
        status: status('Trying {args.url}…', 'Tried {args.url}', 'Trying {args.url} failed'),
        effects: { mode: 'read', free: true },
        tags: ['api', 'read'],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to reach a web API service: its saved requests, or a new one written as a fn.',
        content: [
          'Each api instance is one web API service. Find its saved requests with hub/fns_search (kinds ["api/request"], instance: the service) and call them by name.',
          'When none does what is asked, call api/make_api on the service (on=<service>) with what the request should do; api/operations lists what the service offers.',
        ].join(' '),
        fns: [fns.make_api, fns.operations, fns.test_request],
        tags: ['api'],
      }),
    },
  }));

/**
 * The api system's `connect` (manifest `connect`), per instance: a service whose auth is per person asks each person
 * for their own token or header values (the form flow); its own fns and every saved request act as the person.
 */
export const API_CONNECT: ConnectDecl = ConnectDecl.parse({
  title: 'API sign-ins',
  description: 'Sign in to the web API services that need your own credentials, so the requests you run act as you.',
  icon: 'globe',
  // each instance says how people connect to it (`ctx.instanceConnect`); this is the system-wide default, a token
  how: { flow: 'form', form: wireType(g.obj({ token: g.text({ minLength: 1 }) })) },
  settings: wireType(g.obj({})),
  fns: { make_api: { on: true, ask: false }, operations: { on: true, ask: false }, test_request: { on: true, ask: false } },
  scope: 'instance',
  defaults: { on: true, ask: false },
});

/** The api system's contract. */
export const api = declared.with({ connect: API_CONNECT });

/** The api contract's type. */
export type ApiContract = typeof api;
