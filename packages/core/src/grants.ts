/**
 * What a system declares it may do through the hub (`Manifest.grants`), which the hub enforces over the link
 * and the review page shows, its custom config component (`Manifest.configComponent`), and its stage: installed (paired,
 * nothing offered) or live (reviewed and switched on by an admin). A fn's own mode, types and registry effects stay on
 * `FnDecl.effects`; these are the system-wide limits beside them.
 */
import { z } from 'zod';
import { ModelRole } from './model-calls.ts';
import { QualifiedName, SystemName, Usd } from './primitives.ts';

/**
 * The hub calls a system may make beyond the always-allowed base (hello, manifest and patch, uploading bytes to the
 * content store, which its client bundle needs during the handshake; its own runs' progress, outcomes, handlers,
 * control and logs, types and fleet). Each names a group of link endpoints:
 * - `ai`: `llm`, `model`, `models` (ctx.ai(), ctx.llm)
 * - `embed`: `embed`
 * - `resources`: `resource`, `resourceSections`, `content`, `resourcesChanged` (reading what others stored)
 * - `fns`: `call`, `usableFns`, `shareFn` (calling other fns; which ones is `SystemGrants.calls`)
 * - `search`: `searchFns`, `fnExamples`, `examples`
 * - `decide`: `decide`
 * - `approvals`: `propose`, `grantPairing`, `reportRefusal` (hosting others)
 * - `connections`: `connectionUpdate`
 * - `settings`: `setting`
 * - `state`: `stateGet`, `stateSet`
 * - `data` (build 8): `records`, `record`, `recordTable`, `saveRecord`, `removeRecord`
 */
export const HUB_CAPABILITIES = ['ai', 'embed', 'resources', 'fns', 'search', 'decide', 'approvals', 'connections', 'settings', 'state', 'data'] as const;
export const HubCapability = z.enum(HUB_CAPABILITIES);
export type HubCapability = z.infer<typeof HubCapability>;

/** What a system's model calls may use and spend; absent parts are not limited beyond the hub's own budgets. */
export const ModelGrant = z.object({
  /** The model roles it may ask for; absent, any. */
  roles: z.array(ModelRole).optional(),
  /** Models it may name directly (`provider/id`); absent, only through roles. */
  models: z.array(z.string().min(1)).optional(),
  /** The most one run may spend on model calls. */
  perRun: Usd.optional(),
  /** The most the system may spend in a day, across every run and instance. */
  perDay: Usd.optional(),
});
export type ModelGrant = z.infer<typeof ModelGrant>;

/** Paths a supervised system may reach, relative to its instance folders or absolute (`fs` roots). */
export const FileGrant = z.object({ read: z.array(z.string().min(1)), write: z.array(z.string().min(1)) });
export type FileGrant = z.infer<typeof FileGrant>;

/**
 * Everything a system may do through the hub and, when fs supervises it, on its machine. A system that declares no
 * grants gets the base only. The hub refuses (and logs as a `RefusalRecord`) anything outside them.
 */
export const SystemGrants = z.object({
  hub: z.array(HubCapability),
  models: ModelGrant.optional(),
  /** Hub secrets it may read, by name (its own config secrets are always its own). */
  secrets: z.array(z.string().min(1)).optional(),
  /** The fns (`database/run_query`) or whole systems (`database`) it may call; its fns' `deps` must fall inside. */
  calls: z.array(z.union([QualifiedName, SystemName])).optional(),
  /** Hosts it may reach (`api.tavily.com`, `*.googleapis.com`); enforced by the supervisor for hosted systems. */
  network: z.array(z.string().min(1)).optional(),
  /** Paths it may read and write; enforced by Node's permission model for hosted systems. */
  files: FileGrant.optional(),
});
export type SystemGrants = z.infer<typeof SystemGrants>;

/**
 * A system's own config component (a Vue component exported by its client bundle under `component`). `replace` draws
 * it instead of the gin form; `beside` draws it under the form. It gets the config, its gin type, a validate callback
 * and the system's client; the hub still checks the value with the gin type before saving.
 */
export const ConfigComponentDecl = z.object({ component: z.string().min(1), mode: z.enum(['replace', 'beside']) });
export type ConfigComponentDecl = z.infer<typeof ConfigComponentDecl>;

/**
 * Where a system is in its life: `installed` (paired and connected; nothing it offers is live, only the admin's test
 * calls run) or `live` (an admin reviewed its contract and went live). Systems stored before build 7 have no stage and
 * count as live.
 */
export const SYSTEM_STAGES = ['installed', 'live'] as const;
export const SystemStage = z.enum(SYSTEM_STAGES);
export type SystemStage = z.infer<typeof SystemStage>;
