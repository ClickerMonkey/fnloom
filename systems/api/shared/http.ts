/**
 * The shapes of one HTTP request and its response as an api fn's programs build and read them (product's
 * `design/api-kind.md` §2.1), zod first: the gin types the contract declares (`api/HttpRequest`, …) are read off these,
 * and the executor parses a request a program built with them.
 *
 * - `params` and `headers` are ordered lists of named pairs: a query string and a header bag may repeat a key.
 * - The body's slot is its encoding: set exactly one of `json`, `form`, `multipart`, `text` or `binary`.
 * - A file (a multipart part or a binary body) is a resource URI the hub serves; its text is what is sent.
 */
import { HttpMethod, Json, ResourceUri } from '@harness/core';
import { z } from 'zod';

/** One request header; order is kept and a name may repeat. */
export const HttpHeader = z.object({ key: z.string().min(1), value: z.string() });
export type HttpHeader = z.infer<typeof HttpHeader>;

/** How a list or obj param value is spelled (OpenAPI 3.1); absent: `form` with `explode`, so a list repeats its key. */
export const ParamStyle = z.enum(['form', 'spaceDelimited', 'pipeDelimited', 'deepObject', 'json']);
export type ParamStyle = z.infer<typeof ParamStyle>;

/** One query (or form) parameter; order is kept and a name may repeat. */
export const HttpParam = z.object({ key: z.string().min(1), value: Json, style: ParamStyle.optional(), explode: z.boolean().optional() });
export type HttpParam = z.infer<typeof HttpParam>;

/** One multipart/form-data part: a text value or a resource's text. */
export const HttpPart = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
  resource: ResourceUri.optional(),
  filename: z.string().optional(),
  contentType: z.string().optional(),
});
export type HttpPart = z.infer<typeof HttpPart>;

/** The body: the slot set is the wire encoding, and exactly one is set. */
export const HttpBody = z.object({
  json: Json.optional(),
  form: z.array(HttpParam).optional(),
  multipart: z.array(HttpPart).optional(),
  text: z.string().optional(),
  /** A resource whose text is the body, sent with its own type. */
  binary: ResourceUri.optional(),
});
export type HttpBody = z.infer<typeof HttpBody>;

/** The body slots, in the order they are named to the agent. */
export const BODY_SLOTS = ['json', 'form', 'multipart', 'text', 'binary'] as const satisfies ReadonlyArray<keyof HttpBody>;

/** One outbound request: what an api fn's request program gives. Its url is relative to the service's base URL. */
export const HttpRequest = z.object({
  method: HttpMethod,
  url: z.string(),
  params: z.array(HttpParam).optional(),
  headers: z.array(HttpHeader).optional(),
  body: HttpBody.optional(),
});
export type HttpRequest = z.infer<typeof HttpRequest>;

/** The response as the output program reads it (`response`); `body` is typed by the fn's `responseType`. */
export const HttpResponse = z.object({ status: z.number().int(), headers: z.array(HttpHeader), body: Json });
export type HttpResponse = z.infer<typeof HttpResponse>;
