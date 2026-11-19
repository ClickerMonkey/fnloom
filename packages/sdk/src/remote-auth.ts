/**
 * Signing in to a remote service from an instance's `auth` (core's `RemoteAuth`), shared by every instance-scoped
 * system that calls one (an MCP server, an API service): what the hub's Connections page shows for the instance
 * (`instanceConnectOf`, for `ctx.instanceConnect`), the form a person fills for a per-person token or headers, the
 * credentials kept for them (core's `RemoteCredentials`), and the headers a call sends. Shared tokens and header values
 * are the instance's config secrets; per-person ones and OAuth tokens are the person's connection, kept by the hub.
 */
import { connectFlowOf, RemoteCredentials, type InstanceConnect, type Json, type RemoteAuth } from '@harness/core';
import type { z } from 'zod';
import { g, parseValue, wireType, type GinType } from './gin.ts';

/**
 * Whose typed token or header values a connect form takes: `person`, only a per-person auth's (each person their own);
 * `any`, a shared one's too (one admin types it for everyone, for a key whose record holds no secret: `keyConnectOf`).
 */
export type FormFor = 'person' | 'any';

/** The form to connect with a typed token or header values (`FormFor`); `undefined` for any other auth. */
export function connectForm(auth: RemoteAuth, who: FormFor = 'person'): GinType<Record<string, string>> | undefined {
  if (auth.kind !== 'bearer' && auth.kind !== 'headers') return undefined;
  if (auth.per === 'shared' && who === 'person') return undefined;
  const whose = auth.per === 'shared' ? 'The' : 'Your';
  if (auth.kind === 'bearer') {
    return g.obj({ token: g.field(g.text({ minLength: 1 }), { docs: `${whose} token (sent as \`Authorization: Bearer …\`).` }) });
  }
  return g.obj(Object.fromEntries(auth.names.map((name) => [name, g.field(g.text({ minLength: 1 }), { docs: `${whose} value for the \`${name}\` header.` })])));
}

/**
 * How people connect to an instance, for `ctx.instanceConnect`: OAuth (shared through an admin's sign-in when
 * `per: 'shared'`), a form for a per-person token or headers, or nothing to connect (shared credentials, or none).
 */
export function instanceConnectOf(label: string, auth: RemoteAuth): z.input<typeof InstanceConnect> {
  const flow = connectFlowOf(auth);
  const form = connectForm(auth);
  const share = auth.kind === 'oauth' && auth.per === 'shared';
  if (flow === 'oauth') { return { flow: { flow: 'oauth' }, share, title: share ? `Sign in to ${label} for everyone` : `Sign in to ${label}` }; }
  if (flow === 'form' && form !== undefined) { return { flow: { flow: 'form', form: wireType(form) }, title: `Connect to ${label}` }; }
  return { title: label };
}

/**
 * How people connect to a key of a key-scoped system (a record, which never holds a secret: an API service of the one
 * `api` instance), for the hub's Connections page: a per-person token or headers as each person's own form; a shared
 * token or headers as one admin's form, shared with everyone; OAuth as `instanceConnectOf`; nothing for no auth.
 */
export function keyConnectOf(label: string, auth: RemoteAuth): z.input<typeof InstanceConnect> {
  const form = auth.kind === 'bearer' || auth.kind === 'headers' ? connectForm(auth, 'any') : undefined;
  if (form === undefined || auth.kind === 'none' || auth.per === 'person') return instanceConnectOf(label, auth);
  return { flow: { flow: 'form', form: wireType(form) }, share: true, title: `Set ${label}'s sign-in for everyone` };
}

/** Whether calls use a person's connection (their own, or the one an admin shares) rather than the instance's config. */
export function usesConnections(auth: RemoteAuth): boolean {
  return connectFlowOf(auth) !== undefined;
}

/** The credentials a filled connect form makes, or what is wrong with it. */
export function credentialsFromForm(auth: RemoteAuth, form: Json, who: FormFor = 'person'): { readonly credentials: RemoteCredentials } | { readonly problem: string } {
  const type = connectForm(auth, who);
  if (type === undefined) { return { problem: 'This service connects without a form.' }; }
  let values: Record<string, string>;
  try {
    values = parseValue(type, form);
  } catch {
    return { problem: auth.kind === 'bearer' ? 'Give your token.' : 'Give a value for every header.' };
  }
  const token = values['token'];
  if (auth.kind === 'bearer' && token !== undefined) { return { credentials: { token } }; }
  return { credentials: { headers: values } };
}

/** The headers a person's credentials send. */
export function credentialHeaders(credentials: RemoteCredentials): Record<string, string> {
  if ('token' in credentials) { return { authorization: `Bearer ${credentials.token}` }; }
  if ('headers' in credentials) { return { ...credentials.headers }; }
  return { authorization: `${credentials.tokenType} ${credentials.accessToken}` };
}

/** The headers the instance's own config sends: a shared token or shared header values; none otherwise. */
export function sharedHeaders(auth: RemoteAuth): Record<string, string> {
  if (auth.kind === 'bearer' && auth.per === 'shared' && auth.token !== undefined) { return { authorization: `Bearer ${auth.token}` }; }
  if (auth.kind === 'headers' && auth.per === 'shared') { return { ...auth.values }; }
  return {};
}

/** A connection's credentials, read; `undefined` when they aren't `RemoteCredentials`. */
export function readCredentials(value: Json): RemoteCredentials | undefined {
  const read = RemoteCredentials.safeParse(value);
  return read.success ? read.data : undefined;
}

/** A short label for an account connected with a token or headers ("Token ending 4f2a"), never the secret itself. */
export function accountLabel(credentials: RemoteCredentials): string {
  if ('token' in credentials) { return `Token ending ${credentials.token.slice(-4)}`; }
  if ('headers' in credentials) { return `Headers ${Object.keys(credentials.headers).join(', ')}`; }
  return 'Signed in';
}

/**
 * Header names a log or a trace must not show: `authorization`, every name a `headers` auth uses, and the usual
 * key headers. Compare in lower case.
 */
export function secretHeaderNames(auth: RemoteAuth): ReadonlySet<string> {
  const names = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);
  if (auth.kind === 'headers') { for (const name of auth.names) { names.add(name.toLowerCase()); } }
  return names;
}

/** Headers with the secret ones masked (`••••` and their last four characters), for a trace or a log. */
export function maskHeaders(headers: Readonly<Record<string, string>>, secret: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, secret.has(name.toLowerCase()) ? `••••${value.length > 12 ? value.slice(-4) : ''}` : value]));
}
