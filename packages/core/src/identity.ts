/**
 * The hub's display name (build 8): the name people see everywhere the app names itself (the brand, the sign-in and
 * setup page, the tab title, the install name, the version line, notification titles). It comes from the admin's
 * setting (the hub option `HUB_NAME_OPTION`) when one is set, else the env setting `HARNESS_NAME`, else
 * `DEFAULT_HUB_NAME`. Code names (packages, the `harness` CLI, env prefixes, storage keys) never change.
 */
import { z } from 'zod';

/** The name when neither the setting nor the env names one. */
export const DEFAULT_HUB_NAME = 'Harness';

/** The hub option the admin's choice is stored under. */
export const HUB_NAME_OPTION = 'hub.name';

/** A display name: one short line of text. */
export const HubDisplayName = z.string().trim().min(1).max(40).refine((name) => !/[\r\n]/.test(name), { message: 'One line only.' });
export type HubDisplayName = z.infer<typeof HubDisplayName>;

/** Where the name in use came from. */
export const HubNameSource = z.enum(['setting', 'env', 'default']);
export type HubNameSource = z.infer<typeof HubNameSource>;

/** The hub as people see it: its display name, where that came from, and its version. */
export const HubIdentity = z.object({ name: HubDisplayName, source: HubNameSource, version: z.string() });
export type HubIdentity = z.infer<typeof HubIdentity>;

/** The admin sets the name, or clears the setting (`null`) to go back to the env's or the default. */
export const SetHubName = z.object({ name: HubDisplayName.nullable() });
export type SetHubName = z.infer<typeof SetHubName>;

/** The name in use: the setting's, else the env's, else the default. */
export function hubNameOf(setting: string | undefined, env: string | undefined): { readonly name: HubDisplayName; readonly source: HubNameSource } {
  const stored = HubDisplayName.safeParse(setting);
  if (stored.success) { return { name: stored.data, source: 'setting' }; }
  const fromEnv = HubDisplayName.safeParse(env);
  if (fromEnv.success) { return { name: fromEnv.data, source: 'env' }; }
  return { name: DEFAULT_HUB_NAME, source: 'default' };
}
