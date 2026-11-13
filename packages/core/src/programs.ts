/**
 * Build 9: the `code` and `api` systems, as in product (`design/api-kind.md`). A code fn is one gin program over its
 * args that may call other fns (`fns.<system>.<name>(…)`); an api fn is a gin program whose result is an
 * `api/HttpRequest`, which the api system performs against its service, plus an optional second program that maps
 * the response to the fn's result. Both are authored by an authoring agent (`code/make_code`, `api/make_api`) with
 * the SDK's staged helper and the gin program runtime (`@harness/sdk/program`), and tested with the SDK test kit.
 *
 * An api fn runs on one service: an instance of the bundled `api` system (config `ApiServiceConfig`) that holds the
 * base URL and signs every request (`RemoteAuth`). A program never sees a credential.
 */
import { z } from 'zod';
import { GinExprDef, GinTypeDef } from './gin.ts';
import { InstanceName, Json } from './primitives.ts';
import { HeaderValues, RemoteAuth, REMOTE_AUTH_SECRETS } from './remote-auth.ts';
import type { ConfigPath } from './config-secrets.ts';

/** The bundled system of code fns. */
export const CODE_SYSTEM = 'code';
/** The kind of a code fn. */
export const CODE_KIND = 'code/program';
/** The bundled system of api fns; each service is an instance. */
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
  /** The service (an `api` instance) it is sent to; the fn runs on it. */
  service: InstanceName,
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

/** One API service: the config of its `api` instance. */
export const ApiServiceConfig = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  /** Every request's URL is relative to this; a program can't leave it. */
  baseUrl: z.url(),
  auth: RemoteAuth.default({ kind: 'none' }),
  /** Headers sent on every request (not secrets; `auth` carries those). */
  headers: HeaderValues.optional(),
  /** An OpenAPI document's URL; the authoring agent reads its operations through `api/operations`. */
  openapi: z.url().optional(),
  /** How long one request may take, in milliseconds. */
  timeout: z.number().int().min(1000).default(60_000),
  /** The largest response body kept, in bytes; a larger one becomes a resource. */
  maxBody: z.number().int().min(1024).default(2_000_000),
});
export type ApiServiceConfig = z.infer<typeof ApiServiceConfig>;

/** The secret config paths of an api service instance. */
export const API_CONFIG_SECRETS = [...REMOTE_AUTH_SECRETS] as const satisfies readonly ConfigPath[];

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
