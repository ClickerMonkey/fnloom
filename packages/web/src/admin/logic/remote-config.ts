/**
 * Build 9: what the forms of a fleet of remote services share (an MCP server, an API service, each an instance of a
 * bundled system): the secrets the hub keeps (sent as `SECRET_KEPT`, sent back to keep them), name and value rows
 * (headers, environment values), the sign-in (`RemoteAuth`) as a draft the inputs edit, the instance name made from
 * the label, and checking a candidate config with its system's own schema, the kept secrets put back after. Pure, so it
 * is tested alone.
 */
import {
  InstanceName, isJsonObject, Json, SECRET_KEPT, type JsonObject, type RemoteAuth, type RemoteAuthPer,
} from '@harness/core';
import type { z } from 'zod';
import { checkPaths, type PathProblems } from '../../state/problems.ts';

// ─── Kept secrets ─────────────────────────────────────────────────────────────

/** The value at a dot path of a config, or undefined. */
export function valueAt(value: Json | undefined, path: string): Json | undefined {
  let at: Json | undefined = value;
  for (const key of path.split('.')) {
    if (!isJsonObject(at)) { return undefined; }
    at = at[key];
  }
  return at;
}

/** A config with `next` at a dot path (made as it goes), or the field removed when `next` is undefined. */
export function withValueAt(value: JsonObject, path: string, next: Json | undefined): JsonObject {
  const [key, ...rest] = path.split('.');
  if (key === undefined) { return value; }
  const { [key]: inner, ...others } = value;
  if (rest.length === 0) { return next === undefined ? others : { ...others, [key]: next }; }
  const child = withValueAt(isJsonObject(inner) ? inner : {}, rest.join('.'), next);
  return { ...others, [key]: child };
}

/** Which of a config's secret paths the hub keeps (sent as `SECRET_KEPT`). */
export function keptPaths(value: Json | undefined, secrets: readonly string[]): Set<string> {
  return new Set(secrets.filter((path) => valueAt(value, path) === SECRET_KEPT));
}

/** A config with every kept secret taken out, so its own schema reads it (secret fields are optional). */
export function withoutKept(value: Json | undefined, secrets: readonly string[]): JsonObject {
  const object = isJsonObject(value) ? value : {};
  return [...keptPaths(object, secrets)].reduce((config, path) => withValueAt(config, path, undefined), object);
}

/** A checked config ready to send, or a message per field path. */
export type CheckedConfig = { readonly ok: true; readonly config: JsonObject } | { readonly ok: false; readonly problems: PathProblems };

/**
 * Check a candidate config (kept secrets left out) with its system's schema, then put `SECRET_KEPT` back at each kept
 * path, which tells the hub to keep the stored secret.
 */
export function checkConfig(schema: z.ZodType, candidate: JsonObject, kept: readonly string[]): CheckedConfig {
  const checked = checkPaths(schema, candidate);
  if (!checked.ok) { return checked; }
  const parsed = Json.safeParse(checked.value);
  if (!parsed.success || !isJsonObject(parsed.data)) { return { ok: false, problems: { '': 'Check this config.' } }; }
  return { ok: true, config: kept.reduce((config, path) => withValueAt(config, path, SECRET_KEPT), parsed.data) };
}

// ─── Name and value rows ──────────────────────────────────────────────────────

/** One name and value (a header, an environment value), as the inputs hold it. */
export interface PairRow {
  readonly name: string;
  readonly value: string;
}

/** A record's entries as rows. */
export function rowsOf(record: Json | undefined): PairRow[] {
  if (!isJsonObject(record)) { return []; }
  return Object.entries(record).flatMap(([name, value]) => (typeof value === 'string' ? [{ name, value }] : []));
}

/** Rows as a record: rows without a name are left out; absent when none is left. */
export function recordOf(rows: readonly PairRow[]): Record<string, string> | undefined {
  const named = rows.filter((row) => row.name.trim() !== '');
  return named.length === 0 ? undefined : Object.fromEntries(named.map((row) => [row.name.trim(), row.value]));
}

/** Text with surrounding blanks gone, or undefined when nothing is left. */
export function textOr(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A number typed in a field, scaled (seconds to milliseconds), or `NaN` for the schema to refuse; undefined when blank. */
export function numberOr(text: string, scale = 1): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') { return undefined; }
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value * scale) : Number.NaN;
}

// ─── The sign-in ──────────────────────────────────────────────────────────────

export type RemoteAuthKind = RemoteAuth['kind'];

/** Each way of signing in, in words. */
export const AUTH_WORDS = {
  none: { label: 'None', about: 'Calls send no credentials.' },
  bearer: { label: 'Token', about: 'An `Authorization: Bearer` token.' },
  headers: { label: 'Headers', about: 'Header values, such as an API key in `X-Api-Key`.' },
  oauth: { label: 'OAuth', about: 'Signing in through the browser; the hub keeps and refreshes the tokens.' },
} as const satisfies Record<RemoteAuthKind, { readonly label: string; readonly about: string }>;

/** Whose credentials calls use, in words; the OAuth words differ (shared is one admin's sign-in). */
export const PER_WORDS = {
  shared: { label: 'Shared', about: 'One set for everyone, typed here and kept sealed.', oauth: 'An admin signs in once on the connections page; everyone uses that sign-in.' },
  person: { label: 'Each person', about: 'Each person types their own on the connections page.', oauth: 'Each person signs in with their own account on the connections page.' },
} as const satisfies Record<RemoteAuthPer, { readonly label: string; readonly about: string; readonly oauth: string }>;

/** The secrets of a sign-in the hub may keep, by their field. */
export type AuthSecret = 'token' | 'values' | 'clientSecret';

/** A sign-in as the inputs hold it. */
export interface AuthDraft {
  readonly kind: RemoteAuthKind;
  readonly per: RemoteAuthPer;
  /** The shared token; blank keeps a kept one. */
  readonly token: string;
  /** Header names, with their shared values (blank while the values are kept). */
  readonly headers: readonly PairRow[];
  readonly scopes: readonly string[];
  readonly clientId: string;
  /** The client's secret; blank keeps a kept one. */
  readonly clientSecret: string;
  /** The secrets the hub keeps for this sign-in. Replacing the header values takes `values` out. */
  readonly kept: readonly AuthSecret[];
}

/** The draft of a saved sign-in (as the hub sent it, its kept secrets read from `kept`, paths under `auth.`). */
export function authDraft(auth: RemoteAuth | undefined, kept: ReadonlySet<string> = new Set()): AuthDraft {
  const secrets = (['token', 'values', 'clientSecret'] as const).filter((field) => kept.has(`auth.${field}`));
  const base: AuthDraft = { kind: 'none', per: 'shared', token: '', headers: [], scopes: [], clientId: '', clientSecret: '', kept: secrets };
  switch (auth?.kind) {
    case undefined: case 'none': return base;
    case 'bearer': return { ...base, kind: 'bearer', per: auth.per, token: auth.token ?? '' };
    case 'headers': return { ...base, kind: 'headers', per: auth.per, headers: auth.names.map((name) => ({ name, value: auth.values?.[name] ?? '' })) };
    case 'oauth': return { ...base, kind: 'oauth', per: auth.per, scopes: auth.scopes ?? [], clientId: auth.clientId ?? '', clientSecret: auth.clientSecret ?? '' };
  }
}

/** Whether a secret is kept and nothing new was typed over it. */
function keeps(draft: AuthDraft, field: AuthSecret, typed: boolean): boolean {
  return draft.kept.includes(field) && !typed;
}

/** A sign-in's candidate value (kept secrets left out) and the config paths of the secrets it keeps. */
export function authCandidate(draft: AuthDraft): { readonly auth: JsonObject; readonly kept: string[] } {
  const shared = draft.per === 'shared';
  switch (draft.kind) {
    case 'none': return { auth: { kind: 'none' }, kept: [] };
    case 'bearer': {
      const keep = shared && keeps(draft, 'token', draft.token.trim() !== '');
      const token = shared && !keep ? textOr(draft.token) : undefined;
      return { auth: { kind: 'bearer', per: draft.per, ...(token === undefined ? {} : { token }) }, kept: keep ? ['auth.token'] : [] };
    }
    case 'headers': {
      const names = draft.headers.map((row) => row.name.trim()).filter((name) => name !== '');
      const keep = shared && keeps(draft, 'values', false);
      const values = shared && !keep ? recordOf(draft.headers) : undefined;
      return { auth: { kind: 'headers', per: draft.per, names, ...(values === undefined ? {} : { values }) }, kept: keep ? ['auth.values'] : [] };
    }
    case 'oauth': {
      const keep = keeps(draft, 'clientSecret', draft.clientSecret.trim() !== '');
      const clientId = textOr(draft.clientId);
      const clientSecret = keep ? undefined : textOr(draft.clientSecret);
      return {
        auth: {
          kind: 'oauth', per: draft.per,
          ...(draft.scopes.length === 0 ? {} : { scopes: [...draft.scopes] }),
          ...(clientId === undefined ? {} : { clientId }),
          ...(clientSecret === undefined ? {} : { clientSecret }),
        },
        kept: keep && clientId !== undefined ? ['auth.clientSecret'] : [],
      };
    }
  }
}

/** How people connect for a sign-in, in a few words (the list rows and the overview show it). */
export function authSummary(auth: RemoteAuth): string {
  if (auth.kind === 'none') { return 'No sign-in'; }
  const who = auth.per === 'shared' ? 'shared' : 'per person';
  return `${AUTH_WORDS[auth.kind].label}, ${who}`;
}

// ─── Names ────────────────────────────────────────────────────────────────────

/** An instance name made from a label ("Linear tickets" → `linear-tickets`), or undefined when nothing is left. */
export function instanceNameOf(label: string): InstanceName | undefined {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 48);
  const parsed = InstanceName.safeParse(slug);
  return parsed.success ? parsed.data : undefined;
}
