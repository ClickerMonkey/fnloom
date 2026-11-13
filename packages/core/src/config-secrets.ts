/**
 * Secret fields in a system's config. A system lists the dot paths of its config's secret fields (text, or a record of text)
 * (`Manifest.configSecrets`, also in `PairingInfo` so the pairing page knows before the manifest comes). The hub seals
 * each such value into its `secrets` table when the config is saved and stores the config with the secret's id in its
 * place; only `configure` on the system link carries the plain value. The web app is sent `SECRET_KEPT` in each set
 * secret field, and sending `SECRET_KEPT` back keeps the stored secret. Exports leave secret fields out unless the
 * admin asks for them.
 */
import { z } from 'zod';
import { SecretId } from './primitives.ts';

/** A config field path: object keys joined with dots (`connection.password`). Array items are not addressed. */
export const ConfigPath = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/);
export type ConfigPath = z.infer<typeof ConfigPath>;

/** The secret fields of a config. */
export const ConfigSecrets = z.array(ConfigPath);
export type ConfigSecrets = z.infer<typeof ConfigSecrets>;

/** What the web app sees in a secret field that is set, and sends back to keep it. */
export const SECRET_KEPT = '•••• kept';

/**
 * How the hub stores a secret field inside a saved config value. A text field is sealed as it is; any other value (a
 * record of text, such as an MCP server's environment or header values) is sealed whole as JSON text (`json`).
 */
export const SealedConfigSecret = z.object({ $secret: SecretId, json: z.literal(true).optional() });
export type SealedConfigSecret = z.infer<typeof SealedConfigSecret>;
