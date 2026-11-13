/**
 * Build 9: API services as the admin pages show them (each an instance of the bundled `api` system, whose api fns run
 * on it): the form's draft of an `ApiServiceConfig` and the config it sends. Pure, so it is tested alone.
 */
import { API_CONFIG_SECRETS, API_SYSTEM, ApiServiceConfig, SystemName, type Json, type JsonObject } from '@harness/core';
import {
  authCandidate, authDraft, checkConfig, keptPaths, numberOr, recordOf, rowsOf, textOr, withoutKept, type AuthDraft, type CheckedConfig, type PairRow,
} from './remote-config.ts';

/** The `api` system's name. */
export const API = SystemName.parse(API_SYSTEM);

/** An API service's form as the inputs hold it. Numbers are text as typed: the timeout in seconds, the body ceiling in KB. */
export interface ApiServiceDraft {
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
const DEFAULTS = ApiServiceConfig.pick({ timeout: true, maxBody: true }).parse({});

/** A saved service config as the hub sent it, read (kept secrets left out), or undefined when it isn't one. */
export function readApiService(value: Json | undefined): ApiServiceConfig | undefined {
  const read = ApiServiceConfig.safeParse(withoutKept(value, API_CONFIG_SECRETS));
  return read.success ? read.data : undefined;
}

/** The draft of a saved service config as the hub sent it (kept secrets as `SECRET_KEPT`), or a new service's. */
export function apiServiceDraft(value?: Json): ApiServiceDraft {
  const config = readApiService(value);
  const options = config ?? DEFAULTS;
  return {
    label: config?.label ?? '',
    description: config?.description ?? '',
    baseUrl: config?.baseUrl ?? '',
    auth: authDraft(config?.auth, keptPaths(value, API_CONFIG_SECRETS)),
    headers: rowsOf(config?.headers),
    openapi: config?.openapi ?? '',
    timeout: String(options.timeout / 1000),
    maxBody: String(Math.round(options.maxBody / 1024)),
  };
}

/** The config a draft sends, checked with `ApiServiceConfig`; kept secrets go back as `SECRET_KEPT`. */
export function apiServiceConfig(draft: ApiServiceDraft): CheckedConfig {
  const auth = authCandidate(draft.auth);
  const description = textOr(draft.description);
  const headers = recordOf(draft.headers);
  const openapi = textOr(draft.openapi);
  const timeout = numberOr(draft.timeout, 1000);
  const maxBody = numberOr(draft.maxBody, 1024);
  const candidate: JsonObject = {
    label: draft.label.trim(),
    ...(description === undefined ? {} : { description }),
    baseUrl: draft.baseUrl.trim(),
    auth: auth.auth,
    ...(headers === undefined ? {} : { headers }),
    ...(openapi === undefined ? {} : { openapi }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(maxBody === undefined ? {} : { maxBody }),
  };
  return checkConfig(ApiServiceConfig, candidate, auth.kept);
}
