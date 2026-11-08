/**
 * The hub's own secrets: the JWT secret, the key that seals stored secrets, the files signing secret and the VAPID
 * key pair. A value given in the environment wins; any other is generated once and kept in the keys file (readable
 * only by its owner where the platform allows), so restarts keep every token and secret working.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { HubSettings } from './env.ts';

/** The keys file. */
export const HubKeys = z.object({
  jwtSecret: z.string().min(32),
  secretKey: z.string().min(32),
  filesSecret: z.string().min(32),
  vapid: z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) }),
});
export type HubKeys = z.infer<typeof HubKeys>;

/** The keys file as it may be on disk: anything missing is made. */
const StoredKeys = HubKeys.partial();
type StoredKeys = z.infer<typeof StoredKeys>;

/** Makes what isn't in the file yet. Injected so tests don't generate real VAPID keys. */
export interface KeyMaker {
  secret(): string;
  vapid(): Promise<HubKeys['vapid']> | HubKeys['vapid'];
}

/** A random secret of 32 bytes, base64url. */
export const randomSecret = (): string => randomBytes(32).toString('base64url');

/** Read the keys file, fill what's missing, write it back if anything was made, then let the environment win. */
export async function loadKeys(settings: Pick<HubSettings, 'hubEnv' | 'authEnv' | 'pushEnv'>, make: KeyMaker): Promise<HubKeys> {
  const file = settings.hubEnv.HARNESS_KEYS_FILE;
  const stored: StoredKeys = await readFile(file, 'utf8').then((text) => StoredKeys.parse(JSON.parse(text)), (error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { return StoredKeys.parse({}); }
    throw error;
  });
  const keys: HubKeys = {
    jwtSecret: stored.jwtSecret ?? make.secret(),
    secretKey: stored.secretKey ?? make.secret(),
    filesSecret: stored.filesSecret ?? make.secret(),
    vapid: stored.vapid ?? await make.vapid(),
  };
  if (!HubKeys.safeParse(stored).success) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  }
  const { authEnv, pushEnv } = settings;
  return {
    jwtSecret: authEnv.HARNESS_JWT_SECRET ?? keys.jwtSecret,
    secretKey: authEnv.HARNESS_SECRET_KEY ?? keys.secretKey,
    filesSecret: authEnv.HARNESS_FILES_SECRET ?? keys.filesSecret,
    vapid: pushEnv.HARNESS_VAPID_PUBLIC !== undefined && pushEnv.HARNESS_VAPID_PRIVATE !== undefined
      ? { publicKey: pushEnv.HARNESS_VAPID_PUBLIC, privateKey: pushEnv.HARNESS_VAPID_PRIVATE }
      : keys.vapid,
  };
}
