import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHubSettings, type HubSettings } from './env.ts';
import { HubKeys, loadKeys, type KeyMaker } from './keys.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });

function settingsIn(overrides: { auth?: Partial<HubSettings['authEnv']>; push?: Partial<HubSettings['pushEnv']> } = {}): HubSettings {
  const dir = mkdtempSync(join(tmpdir(), 'harness-keys-'));
  dirs.push(dir);
  const base = parseHubSettings();
  return {
    ...base,
    hubEnv: { ...base.hubEnv, HARNESS_KEYS_FILE: join(dir, 'nested', 'keys.json') },
    authEnv: { ...base.authEnv, HARNESS_JWT_SECRET: undefined, HARNESS_SECRET_KEY: undefined, HARNESS_FILES_SECRET: undefined, ...overrides.auth },
    pushEnv: { ...base.pushEnv, HARNESS_VAPID_PUBLIC: undefined, HARNESS_VAPID_PRIVATE: undefined, ...overrides.push },
  };
}

function counter(): KeyMaker & { made: number } {
  const maker = {
    made: 0,
    secret: () => { maker.made += 1; return `generated-secret-${String(maker.made).padStart(30, '0')}`; },
    vapid: () => { maker.made += 1; return { publicKey: 'pub', privateKey: 'priv' }; },
  };
  return maker;
}

describe('loadKeys', () => {
  it('makes every key on first start and keeps them in the keys file', async () => {
    const settings = settingsIn();
    const maker = counter();
    const keys = await loadKeys(settings, maker);
    expect(maker.made).toBe(4);
    const file = settings.hubEnv.HARNESS_KEYS_FILE;
    expect(HubKeys.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual(keys);
    if (process.platform !== 'win32') { expect(statSync(file).mode & 0o777).toBe(0o600); }
  });

  it('reads them back on the next start without making new ones', async () => {
    const settings = settingsIn();
    const first = await loadKeys(settings, counter());
    const maker = counter();
    await expect(loadKeys(settings, maker)).resolves.toEqual(first);
    expect(maker.made).toBe(0);
  });

  it('lets the environment win', async () => {
    const jwt = 'from-the-environment-0123456789-0123456789';
    const settings = settingsIn({ auth: { HARNESS_JWT_SECRET: jwt }, push: { HARNESS_VAPID_PUBLIC: 'envpub', HARNESS_VAPID_PRIVATE: 'envpriv' } });
    const keys = await loadKeys(settings, counter());
    expect(keys.jwtSecret).toBe(jwt);
    expect(keys.vapid).toEqual({ publicKey: 'envpub', privateKey: 'envpriv' });
    expect(HubKeys.parse(JSON.parse(readFileSync(settings.hubEnv.HARNESS_KEYS_FILE, 'utf8'))).jwtSecret).not.toBe(jwt);
  });
});
