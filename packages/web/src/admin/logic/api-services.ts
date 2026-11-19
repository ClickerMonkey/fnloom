/**
 * API services as the admin pages show them: records of the one `api` instance (`api/Service`, core's `ApiService`),
 * which api fns are sent to. The form's draft of a service and the value it saves, checked with `ApiService` itself, and
 * the queries the pages send (the services by words, one by name, its fns): every search and filter runs in the hub's
 * database. A service holds no secret: a shared token is set by an admin on the API sign-ins page. Pure, so it is
 * tested alone.
 */
import {
  API_SERVICE_TYPE, API_SYSTEM, ApiService, ConnectKey, QualifiedName, SystemName, type Json, type ListQuery, type RecordQuery, type TypedAuth,
} from '@harness/core';
import { checkPaths, type PathProblems } from '../../state/problems.ts';
import { authCandidate, authDraft, instanceNameOf, numberOr, recordOf, rowsOf, textOr, type AuthDraft, type PairRow } from './remote-config.ts';

/** The `api` system's name. */
export const API = SystemName.parse(API_SYSTEM);

/** The stored type of services. */
export const SERVICE_TYPE = QualifiedName.parse(API_SERVICE_TYPE);

/** The ways an API service signs in (`RecordAuth`): no OAuth, since a service names no endpoints to sign in through. */
export const API_AUTH_KINDS = ['none', 'bearer', 'headers'] as const satisfies readonly TypedAuth['kind'][];

/** An API service's form as the inputs hold it. Numbers are text as typed: the timeout in seconds, the body ceiling in KB. */
export interface ApiServiceDraft {
  /** Its key: fns and connections name it, so it is set once, when it is added. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly auth: AuthDraft;
  /** Headers sent on every request (not secrets). */
  readonly headers: readonly PairRow[];
  readonly openapi: string;
  readonly timeout: string;
  readonly maxBody: string;
}

/** A new service's settings: the schema's own defaults. */
const DEFAULTS = ApiService.pick({ timeout: true, maxBody: true }).parse({});

/** A record's value read as a service, or undefined when it isn't one. */
export function readApiService(value: Json | undefined): ApiService | undefined {
  const read = ApiService.safeParse(value);
  return read.success ? read.data : undefined;
}

/** The draft of a saved service, or a new one's. */
export function apiServiceDraft(service?: ApiService): ApiServiceDraft {
  const options = service ?? DEFAULTS;
  return {
    name: service?.name ?? '',
    label: service?.label ?? '',
    description: service?.description ?? '',
    baseUrl: service?.baseUrl ?? '',
    auth: authDraft(service?.auth),
    headers: rowsOf(service?.headers),
    openapi: service?.openapi ?? '',
    timeout: String(options.timeout / 1000),
    maxBody: String(Math.round(options.maxBody / 1024)),
  };
}

/** The name a new service gets from its label when none is typed (`GitHub API` → `github-api`). */
export function serviceNameOf(draft: Pick<ApiServiceDraft, 'name' | 'label'>): string {
  return draft.name.trim() !== '' ? draft.name.trim() : instanceNameOf(draft.label) ?? '';
}

/** The service a draft saves, checked with `ApiService`; a secret typed in the sign-in is never part of it. */
export function apiServiceValue(draft: ApiServiceDraft): { readonly ok: true; readonly service: ApiService } | { readonly ok: false; readonly problems: PathProblems } {
  const { auth } = authCandidate(draft.auth);
  const description = textOr(draft.description);
  const headers = recordOf(draft.headers);
  const openapi = textOr(draft.openapi);
  const timeout = numberOr(draft.timeout, 1000);
  const maxBody = numberOr(draft.maxBody, 1024);
  const checked = checkPaths(ApiService, {
    name: serviceNameOf(draft),
    label: draft.label.trim(),
    ...(description === undefined ? {} : { description }),
    baseUrl: draft.baseUrl.trim(),
    // the record's sign-in is how, never what: `RecordAuth` drops a token or header values typed here
    auth,
    ...(headers === undefined ? {} : { headers }),
    ...(openapi === undefined ? {} : { openapi }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(maxBody === undefined ? {} : { maxBody }),
  });
  return checked.ok ? { ok: true, service: checked.value } : checked;
}

/** The page of services the list shows: by words when searching (the hub's text index), else by label. */
export function servicesQuery(text: string, limit = 100): RecordQuery {
  const words = text.trim();
  return { type: SERVICE_TYPE, query: { limit, ...(words === '' ? { sort: [{ field: 'label', dir: 'asc' }] } : {}) }, ...(words === '' ? {} : { search: words }) };
}

/** The one service by its name (a filter in the database). */
export function serviceQuery(name: ConnectKey | string): RecordQuery {
  return { type: SERVICE_TYPE, query: { filters: [{ field: 'name', op: 'is', value: name }], limit: 1 } };
}

/** A service's api fns (named `api/<service>.<name>`), found in the database. */
export function serviceFnsQuery(name: ConnectKey | string, limit = 100): ListQuery {
  return { filters: [{ field: 'system', op: 'is', value: API }, { field: 'name', op: 'contains', value: `${API}/${name}.` }], limit };
}

/** A route's service name, or undefined when it isn't one. */
export function serviceParam(value: unknown): ConnectKey | undefined {
  const read = ConnectKey.safeParse(value);
  return read.success ? read.data : undefined;
}
