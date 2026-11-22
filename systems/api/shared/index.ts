/**
 * The api system's contract (`shared/`), after product's api kind (build 9 design §5). Like `code`, it is one instance
 * that authors fns: an api fn is code that calls an external service. The services are its records (`api/Service`,
 * core's `ApiService`: the base URL, how it signs in, its OpenAPI document), which the authoring agent picks or adds
 * and admins edit on the API services page. An api fn is a gin program whose result is an `api/HttpRequest`, plus an
 * optional program that maps the response to the fn's result; it is kept in the hub as an `api/request` fn named for
 * its service (`<service>.<name>`) and runs on the one instance.
 *
 * - **The kind** `api/request` (payload `ApiFnSpec`): describing it reads the method off the program (GET and HEAD
 *   read; the others write, so policies ask first) and names its service as the fn's connection key; running it
 *   materializes the request, keeps it under the service's base URL, signs it with the run's connection to the service,
 *   sends it and maps the response. A program never sees a credential.
 * - **Connections** are per service (`connect.scope: 'key'`, the keys being the `api/Service` records): each person
 *   connects their own token or headers, or an admin sets a shared one for everyone (`keyConnectOf`).
 * - **make_api** is an authoring fn: an agent picks the service (or adds one), reads its operations, declares the
 *   signature, writes the request (and output) programs, has them checked (GETs are sent while authoring) and saves the
 *   fn. **services** lists the services; **operations** pages a service's OpenAPI document; **test_request** sends a GET
 *   (or HEAD) to try one.
 */
import { API_KIND, API_SERVICE_RECORDS, API_SERVICE_TYPE, API_SYSTEM, ApiFnSpec, ApiService, ConnectDecl, HttpExchange } from '@harness/core';
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

/** A page of services, found in the hub's database (`services`). */
export const ServicesPage = z.object({ items: z.array(ApiService), cursor: z.string().optional() });
export type ServicesPage = z.infer<typeof ServicesPage>;

/** The named types programs build and read, in dependency order (the authoring agent offers them in this order). */
export const HTTP_TYPES = ['HttpHeader', 'HttpParam', 'HttpPart', 'HttpBody', 'HttpRequest', 'HttpResponse'] as const;

const display = (label: string, plural: string) => ({ label, plural, icon: 'globe', color: '#4f7cac' });

const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: active, many: active },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** A service's name as a fn takes it: its connection key, so the call acts through the person's connection to it. */
const serviceName = () => g.text({ pattern: '^[a-z][a-z0-9-]*$' });
const serviceArg = (docs: string) => g.field(serviceName(), { docs });

/** How callers of `make_api` use it. */
const MAKE_USAGE = [
  'Use it when the person wants something from a web API service (fresh data, or an action on that service) and no saved api fn does it yet: look first with hub/fns_search and kinds ["api/request"].',
  'Find the service first with api/services and name it in `service`. When none is set up, it can add one only from a base URL you give in `request` (the person\'s, or the service\'s documented one): never make up a service or its URL.',
  'Describe the request in `request`: the service or its base URL, the operation (method and path when known, from api/operations), the args, what the result should hold, and an example.',
  'Another agent writes the request, checks it (a GET is sent once to try it) and saves it as an api/request fn named for its service (such as api/github.open_issues). It reuses an api fn that already does it.',
  'It returns `fn`, `signature`, `call` and `preview`: the preview is only the trial while writing it. To answer the person, load the saved fn and call it by name with their args; a request that changes something (anything but GET) asks the person to approve each run.',
  'A service that needs a sign-in uses the person\'s connection to it; if the result says it is not connected, tell the person to connect that service on the Connections page. Don\'t invent other steps or links.',
].join(' ');

/** The contract's declarations, before its `connect` (which names these fns). */
const declared = system(API_SYSTEM, {
  description: 'Web API requests kept as fns, like code: one instance authors api fns (code that calls an external service), each sent to one of its services, whose base URL and sign-in it keeps as records.',
  about: [
    'Requests to web API services: outside services with an API, such as a weather service or an issue tracker. Each service is a record with its base URL and how it signs in.',
    'Its fns: api/services lists the services set up, api/operations lists what one offers (from its OpenAPI document), api/test_request tries one GET, and api/make_api writes a request as a fn of the kind api/request and saves it, named for its service (such as api/github.open_issues).',
    'A saved request is the person\'s to call again by name for fresh data each time; one that changes something on the service (anything but a GET) asks the person to approve each run.',
    'You can\'t connect accounts: a service that needs a sign-in is connected by the person (or an admin, for everyone) on the app\'s Connections page. Never invent links, keys or setup steps, and never promise access to a service that api/services does not list.',
    'Reach for it for a web API; to search the web or read an ordinary page, use the web system instead. Load api/guide before first use.',
  ].join(' '),
  groups: [{ name: 'requests', title: 'Requests', description: 'Write a request to a web API service as a fn, find the services, read their operations, and try a GET.' }],
  // the authoring agent is a model; api fns are hub fns it searches, reads and saves; services are records it reads and
  // adds; requests go to each service's base URL, known only from its record
  grants: { hub: ['ai', 'fns', 'search', 'connections', 'data'], calls: [hub.fns.fn_get.name, hub.fns.save_fn.name], network: ['*'] },
})
  .with({
    types: {
      Service: type({
        description: 'A web API service api fns are sent to: its base URL, how it signs in (the credentials are connections, never part of it), its default headers and its OpenAPI document.',
        shape: ginAs(ApiService),
        display: { label: 'API service', plural: 'API services', icon: 'globe', color: '#4f7cac', title: 'label', subtitle: 'baseUrl' },
        records: { ...API_SERVICE_RECORDS, search: { ...API_SERVICE_RECORDS.search, text: [...API_SERVICE_RECORDS.search.text] } },
      }),
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
        description: 'An api fn: a saved request to one web API service (a program that builds the HTTP request from the args, and optionally one that turns the response into the result). Calling it by name sends the request through the person\'s connection to the service and returns the result.',
        applicability: 'Something read from or done on a web API service the person will ask for again, written by api/make_api and then called by its name.',
        payload: ApiPayload,
        // make_api keeps every fn it writes; a request that changes something asks by its mode on every run
        approveChanges: false,
        status: status('Calling {fn}…', 'Called {fn}', 'Calling {fn} failed'),
      }),
    },
    fns: {
      make_api: fn({
        group: 'requests',
        description: 'Have a request to a web API service written, tried and saved as an api/request fn the person can call again (or reuse one that already does it); it gives back the new fn\'s name and signature.',
        instructions: MAKE_USAGE,
        args: g.obj({
          request: g.field(g.text({ minLength: 1 }), { docs: 'What the request does: the service or its base URL, the operation, its args, what the result holds, and an example.' }),
          service: g.field(g.optional(serviceName()), { docs: 'The service to write it for, by name; left out, the agent picks or adds one.' }),
        }),
        returns: authoredFn,
        deps: { getFn: hub.fns.fn_get, saveFn: hub.fns.save_fn },
        // GETs sent while writing act through the person's connection to the service named
        connectKey: { arg: 'service' },
        examples: [
          { args: { request: 'The open issues of a repository: GET /repos/{owner}/{repo}/issues?state=open; args owner and repo; give each issue\'s number and title.', service: 'github' }, note: 'A GET, tried while it is written.' },
          { args: { request: 'Create an issue on https://api.github.com: POST /repos/{owner}/{repo}/issues with a JSON body of title and body; give the new issue\'s number.' }, note: 'A write, on a service the agent picks or adds: checked but not sent while written, and asks on every run.' },
        ],
        status: status('Writing a request…', 'Wrote {output.fn}', 'Writing a request failed'),
        effects: { mode: 'write', free: false, writes: [API_SERVICE_TYPE], registry: [{ thing: 'fns', action: 'create', kind: API_KIND }] },
        tags: ['api', 'write'],
      }),
      services: fn({
        group: 'requests',
        description: 'The web API services set up for api fns: each one\'s name, label, base URL, how it signs in and whether it has an OpenAPI document, found by words, a page at a time.',
        instructions: 'Use it to check whether a service the person means is set up before you write or promise anything: an empty answer means it isn\'t, so say so. Narrow with `text` (words of its name, label or base URL). Page with `cursor` set to the last page\'s `cursor`. Its `name` is what api/make_api, api/operations and api/test_request take as `service`.',
        args: g.obj({ text: g.optional(g.text()), limit: g.optional(g.num({ min: 1, max: 50, whole: true })), cursor: g.optional(g.text()) }),
        returns: ginAs(ServicesPage),
        examples: [{ args: { text: 'github', limit: 5 } }],
        status: status('Finding services…', 'Found services', 'Finding services failed'),
        effects: { mode: 'read', free: true, reads: [API_SERVICE_TYPE] },
        tags: ['api', 'read'],
      }),
      operations: fn({
        group: 'requests',
        description: 'What a service offers, from its OpenAPI document: each operation\'s method, path and summary, a page at a time.',
        instructions: 'Use it to find the method and path to describe to api/make_api. It works only for a service with an OpenAPI document (api/services says which); for one without, it fails, so describe the request from what the person or the service\'s docs say. Narrow with `text` (words of the path or summary). Page with `offset` set to `next`.',
        args: g.obj({
          service: serviceArg('The service, by name.'),
          text: g.optional(g.text()), offset: g.optional(g.num({ min: 0, whole: true })), limit: g.optional(g.num({ min: 1, max: 100, whole: true })),
        }),
        returns: ginAs(OperationsPage),
        examples: [{ args: { service: 'github', text: 'issues', limit: 10 } }],
        status: status('Reading the operations…', 'Read the operations', 'Reading the operations failed'),
        effects: { mode: 'read', free: true, reads: [API_SERVICE_TYPE] },
        tags: ['api', 'read'],
      }),
      test_request: fn({
        group: 'requests',
        description: 'Send one GET (or HEAD) to a service and show the request and response, with credentials masked. Nothing is saved.',
        instructions: 'Use it to see what an endpoint gives before describing it to api/make_api, or to answer a one-off question. The url is relative to the service\'s base URL (start it with /); query parameters go in `params` as {"key","value"} items.',
        args: g.obj({
          service: serviceArg('The service, by name.'),
          method: g.optional(g.enum(['GET', 'HEAD'])),
          url: g.text(),
          params: g.optional(g.list(ginAs(HttpParam))),
          headers: g.optional(g.list(ginAs(HttpHeader))),
        }),
        returns: ginAs(HttpExchange),
        // it signs with the person's connection to the service it names
        connectKey: { arg: 'service' },
        examples: [{ args: { service: 'github', url: '/repos/acme/web/issues', params: [{ key: 'state', value: 'open' }] } }],
        status: status('Trying {args.url}…', 'Tried {args.url}', 'Trying {args.url} failed'),
        effects: { mode: 'read', free: true, reads: [API_SERVICE_TYPE] },
        tags: ['api', 'read'],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to get data from (or act on) a web API service: its saved requests, or a new one written as a fn.',
        content: [
          '# Web API services',
          '',
          'A service is an outside system with a web API (a weather service, an issue tracker). Each is a record: a name, a base URL, how it signs in. A saved request to one is an api/request fn, named api/<service>.<name>.',
          '',
          'Steps:',
          '1. Is the service set up? api/services {"text":"weather"}. If nothing comes back, it isn\'t: tell the person, and offer to add it only if they give its base URL. Never invent a service, a URL, a key or setup steps.',
          '2. Is there a saved request already? hub/fns_search with kinds ["api/request"] and a few words. If one fits, load it and call it by name.',
          '3. Otherwise api/make_api. Example args: {"request":"The open issues of a repository: GET /repos/{owner}/{repo}/issues?state=open; args owner and repo; give each issue\'s number and title.","service":"github"}. api/operations {"service":"github","text":"issues"} helps you find the method and path first.',
          '4. It answers with the saved fn ({"fn":"api/github.open_issues","signature":…,"preview":…}). The preview was only a trial: load the fn and call it with the person\'s values to get the real answer.',
          '',
          'Sign-ins: a service that needs one uses each person\'s own connection (or an admin\'s, shared). If a call says it is not connected, tell the person to connect that service on the Connections page; you can\'t do it for them.',
          'Requests other than GET change something on the service, so each run asks the person to approve it first. Until they approve, it has not happened.',
          'To search the web or read an ordinary page, use the web system, not this one.',
        ].join('\n'),
        fns: [fns.make_api, fns.services, fns.operations, fns.test_request],
        tags: ['api'],
      }),
    },
  }));

/**
 * The api system's `connect` (manifest `connect`), per service (`scope: 'key'`, the keys being its `api/Service`
 * records): a service whose auth is per person asks each person for their own token or header values (the form flow);
 * a shared one is set once by an admin, for everyone. Every request fn acts through its service's connection, and
 * `make_api` and `test_request` through the one of the service they name.
 */
export const API_CONNECT: ConnectDecl = ConnectDecl.parse({
  title: 'API sign-ins',
  description: 'Sign in to the web API services that need credentials, so the requests you run act as you.',
  icon: 'globe',
  // each service says how people connect to it (its record's auth); this is the system-wide default, a token
  how: { flow: 'form', form: wireType(g.obj({ token: g.text({ minLength: 1 }) })) },
  settings: wireType(g.obj({})),
  fns: { make_api: { on: true, ask: false }, test_request: { on: true, ask: false } },
  scope: 'key',
  keys: { type: API_SERVICE_TYPE },
  defaults: { on: true, ask: false },
});

/** The api system's contract. */
export const api = declared.with({ connect: API_CONNECT });

/** The api contract's type. */
export type ApiContract = typeof api;
