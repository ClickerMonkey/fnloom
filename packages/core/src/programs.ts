/**
 * Build 9: the `code` and `api` systems, as in product (`design/api-kind.md`). A code fn is one gin program over its
 * args that may call other fns (`fns.<system>.<name>(…)`); an api fn is a gin program whose result is an
 * `api/HttpRequest`, which the api system performs against its service, plus an optional second program that maps
 * the response to the fn's result. Both are authored by an authoring agent (`code/make_code`, `api/make_api`) with
 * the SDK's staged helper and the gin program runtime (`@harness/sdk/program`), and tested with the SDK test kit.
 *
 * The `api` system runs one instance, which authors api fns the way `code` authors code fns. Each api fn is sent to one
 * service: an `ApiService` record of that instance (the base URL, how it signs in, its OpenAPI document), which the
 * authoring agent picks or creates. People connect per service (`ConnectDecl.scope: 'key'`); the instance signs every
 * request with the run's connection. A program never sees a credential.
 */
import { z } from 'zod';
import { GinExprDef, GinTypeDef } from './gin.ts';
import { ConnectKey } from './connections.ts';
import type { RecordStorage } from './data.ts';
import { Json } from './primitives.ts';
import { HeaderValues, RecordAuth, TypedAuth, TYPED_AUTH_SECRETS } from './remote-auth.ts';
import type { ConfigPath } from './config-secrets.ts';

/** The bundled system of code fns. */
export const CODE_SYSTEM = 'code';
/** The kind of a code fn. */
export const CODE_KIND = 'code/program';
/** The bundled system of api fns: one instance, whose services are its records (`ApiService`). */
export const API_SYSTEM = 'api';
/** The kind of an api fn. */
export const API_KIND = 'api/request';

/** The payload of a code fn: its signature and its program. The kind describes the fn's args and result from these. */
export const CodeFnSpec = z.object({
  /** The fn's args, an `obj` type: the program reads them as `args.<name>`. */
  args: GinTypeDef,
  /** What the program gives. */
  returns: GinTypeDef,
  /** The program; `args` and `fns` are in its scope. */
  program: GinExprDef,
});
export type CodeFnSpec = z.infer<typeof CodeFnSpec>;

/** The payload of an api fn. */
export const ApiFnSpec = z.object({
  /** The service (an `ApiService` by name) it is sent to; people connect per service. */
  service: ConnectKey,
  /** The fn's args, an `obj` type: the programs read them as `args.<name>`. */
  args: GinTypeDef,
  /** What the fn gives: the output program's result, else the response body. */
  returns: GinTypeDef,
  /** The program whose result is an `api/HttpRequest`; its url is relative to the service's base URL. */
  request: GinExprDef,
  /** The response body's type, when the output program reads it. */
  responseType: GinTypeDef.optional(),
  /** Maps `response` (an `api/HttpResponse` of `responseType`) to the fn's result; absent, the result is the body. */
  output: GinExprDef.optional(),
});
export type ApiFnSpec = z.infer<typeof ApiFnSpec>;

/** HTTP methods an api fn may send. Anything but GET and HEAD is a write: it waits for approval unless a policy allows it. */
export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** An API service's name: its key among the api system's services, and the key people connect to it by. */
export const ApiServiceName = ConnectKey;
export type ApiServiceName = ConnectKey;

/** The stored type of api services (`api/Service`): the api system's records, one per web API service. */
export const API_SERVICE_TYPE = 'api/Service';

/** How `api/Service` keeps its records: shared, searched by label, name, description and base URL. */
export const API_SERVICE_RECORDS = {
  shape: 'table', owner: 'shared', search: { text: ['label', 'name', 'description', 'baseUrl'], embed: false },
} as const satisfies RecordStorage;

/**
 * One web API service, a record of the one `api` instance (`api/Service`): authored like an api fn (the authoring agent
 * picks or creates it), edited by admins on the API services page. It never holds a secret: a shared token or header
 * values are an admin's connection shared with everyone, a per-person one each person's own (`ConnectKeyRecord`).
 */
export const ApiService = z.object({
  /** Its key: api fns name it (`ApiFnSpec.service`) and people connect to it by it. Never changes. */
  name: ApiServiceName,
  label: z.string().min(1),
  description: z.string().optional(),
  /** Every request's URL is relative to this; a program can't leave it. */
  baseUrl: z.url(),
  /** How it signs in; the credentials are connections (`RecordAuth`). */
  auth: RecordAuth.default({ kind: 'none' }),
  /** Headers sent on every request (not secrets; `auth` carries those). */
  headers: HeaderValues.optional(),
  /** An OpenAPI document's URL; the authoring agent reads its operations through `api/operations`. */
  openapi: z.url().optional(),
  /** How long one request may take, in milliseconds. */
  timeout: z.number().int().min(1000).default(60_000),
  /** The largest response body kept, in bytes; a larger one becomes a resource. */
  maxBody: z.number().int().min(1024).default(2 * 1024 * 1024),
});
export type ApiService = z.infer<typeof ApiService>;

/**
 * Before the one-instance api: one service as its own `api` instance's config, a shared token sealed in it. Read once,
 * by the hub's migration that turns each such instance into an `ApiService` record of the one instance.
 */
export const ApiServiceConfig = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  /** Every request's URL is relative to this; a program can't leave it. */
  baseUrl: z.url(),
  /** How it signs in: no OAuth, since an API service names no endpoints to sign in through. */
  auth: TypedAuth.default({ kind: 'none' }),
  /** Headers sent on every request (not secrets; `auth` carries those). */
  headers: HeaderValues.optional(),
  /** An OpenAPI document's URL; the authoring agent reads its operations through `api/operations`. */
  openapi: z.url().optional(),
  /** How long one request may take, in milliseconds. */
  timeout: z.number().int().min(1000).default(60_000),
  /** The largest response body kept, in bytes; a larger one becomes a resource. */
  maxBody: z.number().int().min(1024).default(2 * 1024 * 1024),
});
export type ApiServiceConfig = z.infer<typeof ApiServiceConfig>;

/** The secret config paths of a pre-migration api service instance (`ApiServiceConfig`). */
export const API_CONFIG_SECRETS = [...TYPED_AUTH_SECRETS] as const satisfies readonly ConfigPath[];

/**
 * What `api_test` (the authoring agent's check) and a run's trace show of one request: the materialized request with
 * credentials masked, and the response when it was sent (only GETs are sent while authoring).
 */
export const HttpExchange = z.object({
  method: HttpMethod,
  url: z.string(),
  headers: z.array(z.object({ key: z.string(), value: z.string() })),
  /** The body as sent, in words (`json`, `form`, `multipart` with its parts, `text`, `binary` with the resource). */
  body: z.string().optional(),
  response: z.object({
    status: z.number().int(),
    headers: z.array(z.object({ key: z.string(), value: z.string() })),
    /** The body as JSON or text, cut at `maxBody`; a file response is a resource ref instead. */
    body: Json.optional(),
    ms: z.number().int().min(0),
  }).optional(),
});
export type HttpExchange = z.infer<typeof HttpExchange>;
