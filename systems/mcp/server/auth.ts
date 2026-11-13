/**
 * Signing in to a server, from the instance's `auth` (core's `RemoteAuth`): what the hub's Connections page shows for
 * the instance (`instanceConnect`), the form a person fills for a per-person token or headers, the credentials kept
 * for them (core's `RemoteCredentials`), and the headers each link sends. Shared tokens and headers are the
 * instance's config secrets; per-person ones and OAuth tokens are the person's connection, kept by the hub.
 */
import { connectFlowOf, RemoteCredentials, type InstanceConnect, type Json, type McpServerConfig, type RemoteAuth } from '@harness/core';
import { g, parseValue, wireType, type GinType } from '@harness/sdk';
import type { z } from 'zod';

/** The form a person fills to connect with their own token or header values. */
export function connectForm(auth: RemoteAuth): GinType<Record<string, string>> | undefined {
  if (auth.kind === 'bearer' && auth.per === 'person') {
    return g.obj({ token: g.field(g.text({ minLength: 1 }), { docs: 'Your token for this server (sent as `Authorization: Bearer …`).' }) });
  }
  if (auth.kind === 'headers' && auth.per === 'person') {
    return g.obj(Object.fromEntries(auth.names.map((name) => [name, g.field(g.text({ minLength: 1 }), { docs: `Your value for the \`${name}\` header.` })])));
  }
  return undefined;
}

/** How people connect to this server, as the hub's Connections page shows it. */
export function instanceConnectOf(config: Pick<McpServerConfig, 'label' | 'auth'>): z.input<typeof InstanceConnect> {
  const flow = connectFlowOf(config.auth);
  const form = connectForm(config.auth);
  const share = config.auth.kind === 'oauth' && config.auth.per === 'shared';
  if (flow === 'oauth') { return { flow: { flow: 'oauth' }, share, title: share ? `Sign in to ${config.label} for everyone` : `Sign in to ${config.label}` }; }
  if (flow === 'form' && form !== undefined) { return { flow: { flow: 'form', form: wireType(form) }, title: `Connect to ${config.label}` }; }
  return { title: config.label };
}

/** Whether calls use a person's connection (their own, or the one an admin shares) rather than the instance's config. */
export function usesConnections(auth: RemoteAuth): boolean {
  return connectFlowOf(auth) !== undefined;
}

/** The credentials a filled connect form makes, or what is wrong with it. */
export function credentialsFromForm(auth: RemoteAuth, form: Json): { readonly credentials: RemoteCredentials } | { readonly problem: string } {
  const type = connectForm(auth);
  if (type === undefined) { return { problem: 'This server connects without a form.' }; }
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

/** The headers a set of credentials sends. */
export function headersOf(credentials: RemoteCredentials): Record<string, string> {
  if ('token' in credentials) { return { authorization: `Bearer ${credentials.token}` }; }
  if ('headers' in credentials) { return { ...credentials.headers }; }
  return { authorization: `${credentials.tokenType} ${credentials.accessToken}` };
}

/** The headers the instance's own config sends: a shared token or header values; none otherwise. */
export function sharedHeaders(auth: RemoteAuth): Record<string, string> {
  if (auth.kind === 'bearer' && auth.per === 'shared' && auth.token !== undefined) { return { authorization: `Bearer ${auth.token}` }; }
  if (auth.kind === 'headers' && auth.per === 'shared') { return { ...auth.values }; }
  return {};
}

/** A connection's credentials, read; `undefined` when they aren't credentials this system made. */
export function readCredentials(value: Json): RemoteCredentials | undefined {
  const read = RemoteCredentials.safeParse(value);
  return read.success ? read.data : undefined;
}

/** A short label for an account connected with a token or headers ("Token ending 4f2a"). */
export function accountLabel(credentials: RemoteCredentials): string {
  if ('token' in credentials) { return `Token ending ${credentials.token.slice(-4)}`; }
  if ('headers' in credentials) { return `Headers ${Object.keys(credentials.headers).join(', ')}`; }
  return 'Signed in';
}
