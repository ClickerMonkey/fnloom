/**
 * The api executor: one `HttpRequest` a program built, sent to its service. The url is kept under the base URL, the
 * service's headers and auth are added (a program never sees a credential), params and bodies are encoded by their
 * slot, and the response is read as JSON or text, or kept as a file in the hub when it is binary or past `maxBody`.
 * What happened is an `HttpExchange` with the credentials masked.
 */
import { randomUUID } from 'node:crypto';
import { credentialHeaders, maskHeaders, readCredentials, secretHeaderNames, sharedHeaders, usesConnections } from '@harness/sdk';
import { followRedirects, type FollowedResponse } from '@harness/sdk/server';
import { Json, type ApiServiceConfig, type ContentRef, type HttpExchange, type ResourceUri } from '@harness/core';
import type { HttpParam, HttpRequest } from '../shared/http.ts';

/** Why a request was not sent: it leaves the base URL, its body is not one slot, or there is no credential. */
export class RequestRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestRefused';
  }
}

/** Nobody's credential is there to sign with: the request is right, the person (or an admin) has not connected. */
export class NoCredential extends RequestRefused {
  constructor(message: string) {
    super(message);
    this.name = 'NoCredential';
  }
}

/** The service answered outside 2xx. */
export class ResponseFailed extends Error {
  readonly exchange: HttpExchange;

  constructor(exchange: HttpExchange) {
    const status = exchange.response?.status ?? 0;
    super(`The service answered ${String(status)}: ${JSON.stringify(exchange.response?.body ?? '').slice(0, 300)}`);
    this.name = 'ResponseFailed';
    this.exchange = exchange;
  }
}

/** What sending needs from the run: fetch, the person's connection, files to keep a file response, resource text. */
export interface SendCtx {
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  /** The run's connection credentials (a per-person or OAuth service), as the hub sent them. */
  readonly credentials: Json | undefined;
  /** Keep bytes as a file in the hub; its ref. */
  keep(bytes: Uint8Array, mime: string): Promise<ContentRef>;
  /** A resource's text (a multipart part or a binary body). */
  text(uri: ResourceUri): Promise<string>;
  /** The redirects one request follows; each must stay under the base URL, so a credential never leaves it. */
  readonly maxRedirects: number;
}

/**
 * The headers the service's auth adds: the instance's shared token or header values, or the run's person's (or an
 * admin's shared) connection. `NoCredential` when the one to sign with is not there.
 */
export function authHeaders(config: ApiServiceConfig, credentials: Json | undefined): Record<string, string> {
  const auth = config.auth;
  if (!usesConnections(auth)) {
    const shared = sharedHeaders(auth);
    const wanted = auth.kind === 'headers' ? auth.names : auth.kind === 'bearer' ? ['authorization'] : [];
    const missing = wanted.filter((name) => shared[name] === undefined);
    if (missing.length > 0) throw new NoCredential(`${config.label} has no ${missing.join(', ')} set: an admin sets it on the service.`);
    return shared;
  }
  const read = credentials === undefined ? undefined : readCredentials(credentials);
  if (read === undefined) throw new NoCredential(`Connect to ${config.label} first, on your connections page.`);
  return credentialHeaders(read);
}

/** The base URL's path, ending in a slash. */
function basePath(base: URL): string {
  return base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
}

/** Whether an absolute URL is under the base URL: its origin, and a path within the base path. */
export function underBase(baseUrl: string, target: URL): boolean {
  const base = new URL(baseUrl);
  return target.origin === base.origin && (`${target.pathname}/`).startsWith(basePath(base));
}

/** The request's URL under the base URL; refused when it is absolute or climbs out of the base path. */
export function serviceUrl(baseUrl: string, url: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) throw new RequestRefused(`The url must be relative to the service's base URL (${baseUrl}), not ${url}.`);
  const base = new URL(baseUrl);
  const target = new URL(`${basePath(base)}${url.replace(/^\/+/, '')}`, base.origin);
  if (!underBase(baseUrl, target)) throw new RequestRefused(`${url} leaves the service's base URL (${baseUrl}).`);
  return target;
}

/** A param value as text pieces, by its style. */
function encodeParam(param: HttpParam): Array<[string, string]> {
  const { key, value } = param;
  const style = param.style ?? 'form';
  const explode = param.explode ?? true;
  const text = (item: Json): string => (typeof item === 'string' ? item : JSON.stringify(item));
  if (style === 'json') return [[key, JSON.stringify(value)]];
  if (Array.isArray(value)) {
    if (style === 'form' && explode) return value.map((item) => [key, text(item)]);
    const separator = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    return [[key, value.map(text).join(separator)]];
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (style === 'deepObject') return entries.map(([field, item]) => [`${key}[${field}]`, text(item)]);
    return explode ? entries.map(([field, item]) => [field, text(item)]) : [[key, entries.flatMap(([field, item]) => [field, text(item)]).join(',')]];
  }
  return [[key, value === null ? '' : text(value)]];
}

/** The one body slot a request sets, or why it isn't one. */
export function bodySlot(request: HttpRequest): string | undefined {
  const body = request.body;
  if (body === undefined) return undefined;
  const set = Object.entries(body).filter(([, value]) => value !== undefined).map(([key]) => key);
  if (set.length !== 1) throw new RequestRefused(`Set exactly one body slot (json, form, multipart, text or binary): this body sets ${set.length === 0 ? 'none' : set.join(' and ')}.`);
  return set[0];
}

/** The request as sent: its URL, its init, and the exchange as shown (credentials masked). */
export interface Prepared {
  readonly url: URL;
  readonly init: RequestInit;
  readonly exchange: HttpExchange;
}

/** Build the request: the URL with its params, the headers (the service's, the program's, then the auth), the body. */
export async function prepare(request: HttpRequest, config: ApiServiceConfig, ctx: Pick<SendCtx, 'credentials' | 'text'>): Promise<Prepared> {
  const url = serviceUrl(config.baseUrl, request.url);
  for (const param of request.params ?? []) for (const [key, value] of encodeParam(param)) url.searchParams.append(key, value);
  const auth = authHeaders(config, ctx.credentials);
  const headers = new Headers();
  for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, value);
  for (const header of request.headers ?? []) headers.append(header.key, header.value);
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  const slot = bodySlot(request);
  const body = request.body;
  let sent: BodyInit | undefined;
  let shown: string | undefined;
  if (body !== undefined && slot === 'json') {
    sent = JSON.stringify(body.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    shown = `json ${sent.slice(0, 500)}`;
  } else if (body?.form !== undefined) {
    const form = new URLSearchParams();
    for (const param of body.form) for (const [key, value] of encodeParam(param)) form.append(key, value);
    sent = form;
    shown = `form ${form.toString().slice(0, 500)}`;
  } else if (body?.multipart !== undefined) {
    const form = new FormData();
    for (const part of body.multipart) {
      const text = part.resource === undefined ? (part.value ?? '') : await ctx.text(part.resource);
      if (part.resource === undefined && part.filename === undefined) form.append(part.name, text);
      else form.append(part.name, new Blob([text], { type: part.contentType ?? 'application/octet-stream' }), part.filename ?? part.name);
    }
    // the boundary is made when it is sent: a content-type of the program's would lose it
    headers.delete('content-type');
    sent = form;
    shown = `multipart ${body.multipart.map((part) => part.resource ?? part.name).join(', ')}`;
  } else if (body?.text !== undefined) {
    sent = body.text;
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
    shown = `text ${body.text.slice(0, 500)}`;
  } else if (body?.binary !== undefined) {
    sent = await ctx.text(body.binary);
    shown = `binary ${body.binary}`;
  }
  const secret = new Set([...secretHeaderNames(config.auth), ...Object.keys(auth).map((key) => key.toLowerCase())]);
  const exchange: HttpExchange = {
    method: request.method,
    url: url.toString(),
    headers: Object.entries(maskHeaders(Object.fromEntries(headers.entries()), secret)).map(([key, value]) => ({ key, value })),
    ...(shown === undefined ? {} : { body: shown }),
  };
  return { url, init: { method: request.method, headers, ...(sent === undefined ? {} : { body: sent }) }, exchange };
}

/** Whether a content type is read as text. */
function textual(type: string): boolean {
  return /^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(type);
}

/** What `send` gives: the exchange with its response, and the response as the output program reads it. */
export interface Sent {
  readonly exchange: HttpExchange;
  readonly response: { readonly status: number; readonly headers: Array<{ key: string; value: string }>; readonly body: Json };
}

/**
 * Send a prepared request, following redirects by hand (the SDK's `followRedirects`): every hop must stay under the
 * base URL, since fetch would carry the service's credential headers to any host a redirect names. Only a GET or HEAD
 * follows one; a request that changes something is never sent twice.
 */
async function follow(prepared: Prepared, config: ApiServiceConfig, ctx: SendCtx, signal: AbortSignal): Promise<FollowedResponse> {
  const reads = prepared.init.method === 'GET' || prepared.init.method === 'HEAD';
  return await followRedirects(prepared.url.href, { ...prepared.init, signal }, {
    fetch: ctx.fetch,
    redirects: reads ? ctx.maxRedirects : 0,
    check: (url) => underBase(config.baseUrl, url) ? Promise.resolve() : Promise.reject(new RequestRefused(`The service redirected to ${url.href}, outside its base URL (${config.baseUrl}).`)),
    problems: {
      noLocation: (at) => new RequestRefused(`The service at ${at.href} redirected without saying where.`),
      tooMany: (start, limit) => new RequestRefused(reads ? `${start.href} redirected more than ${String(limit)} times.` : `${start.href} redirected a ${prepared.init.method ?? 'request'}, which is not sent again.`),
    },
  });
}

/** Send a prepared request within the service's timeout; a non-2xx answer throws `ResponseFailed`. */
export async function send(prepared: Prepared, config: ApiServiceConfig, ctx: SendCtx): Promise<Sent> {
  const started = Date.now();
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(config.timeout)]);
  const { response: answer, url } = await follow(prepared, config, ctx, signal);
  const type = answer.headers.get('content-type') ?? '';
  const bytes = new Uint8Array(await answer.arrayBuffer());
  let body: Json;
  if (textual(type) && bytes.length <= config.maxBody) {
    const text = new TextDecoder().decode(bytes);
    body = /json/i.test(type) && text.trim() !== '' ? parseJson(text) : text;
  } else if (bytes.length === 0) {
    body = null;
  } else {
    const ref = await ctx.keep(bytes, type === '' ? 'application/octet-stream' : type);
    body = { content: { hash: ref.hash, size: ref.size, mime: ref.mime } };
  }
  const headers = [...answer.headers.entries()].map(([key, value]) => ({ key, value }));
  const exchange: HttpExchange = { ...prepared.exchange, ...(url === prepared.url ? {} : { url: url.toString() }), response: { status: answer.status, headers, body, ms: Date.now() - started } };
  if (answer.status < 200 || answer.status > 299) throw new ResponseFailed(exchange);
  return { exchange, response: { status: answer.status, headers, body } };
}

/** A JSON body, or its text when it is not JSON after all. */
function parseJson(text: string): Json {
  try {
    const parsed = Json.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : text;
  } catch {
    return text;
  }
}

/** A name for a file response kept in the system's files. */
export function responseFile(): string {
  return `responses/${randomUUID()}`;
}
