import { describe, expect, it } from 'vitest';
import { EnvError } from '@ayepi/env';
import { HUB_ENV, HUB_SETTINGS, hubEnv, parseHubSettings } from './env.ts';

describe('hub settings', () => {
  it('parses every slice, with defaults from the schemas', () => {
    const settings = parseHubSettings();
    expect(Object.keys(settings).sort()).toEqual(Object.keys(HUB_ENV).sort());
    expect(settings.queueEnv.HARNESS_TOOL_TIMEOUT).toBeGreaterThan(0);
    expect(settings.modelEnv.HARNESS_EMBED_BATCH).toBeGreaterThan(0);
  });

  it('derives the public URL from the port unless it is given', () => {
    hubEnv.set('HARNESS_PORT', 4321);
    expect(hubEnv.get('HARNESS_URL')).toBe('http://localhost:4321');
  });

  it('derives the data paths from the data folder', () => {
    hubEnv.set('HARNESS_DATA', 'test-data');
    expect(hubEnv.get('HARNESS_DB_FILE')).toBe('test-data/hub.sqlite');
  });

  it('reports every bad value of every slice at once', () => {
    HUB_SETTINGS.set({ HARNESS_LOG_LEVEL: 'loud', HARNESS_EMBED_BATCH: '0', HARNESS_TURN_ERRORS: '-1' });
    try {
      const error: unknown = (() => { try { parseHubSettings(); return undefined; } catch (thrown) { return thrown; } })();
      expect(error).toBeInstanceOf(EnvError);
      const keys = error instanceof EnvError ? error.issues.map((issue) => issue.path.join('.')).sort() : [];
      expect(keys).toEqual(['HARNESS_EMBED_BATCH', 'HARNESS_LOG_LEVEL', 'HARNESS_TURN_ERRORS']);
    } finally {
      HUB_SETTINGS.set({ HARNESS_LOG_LEVEL: 'info', HARNESS_EMBED_BATCH: '32', HARNESS_TURN_ERRORS: '3' });
    }
    expect(parseHubSettings().logEnv.HARNESS_LOG_LEVEL).toBe('info');
  });

  it('reads SSO providers from the env var as a JSON list, with the schema defaults', () => {
    const json = JSON.stringify([{ id: 'acme', label: 'Acme', issuer: 'https://id.example.com', clientId: 'harness', claims: { admin: ['admins'] } }]);
    HUB_SETTINGS.set({ HARNESS_SSO_PROVIDERS: json });
    try {
      const [provider, ...rest] = parseHubSettings().authEnv.HARNESS_SSO_PROVIDERS;
      expect(rest).toEqual([]);
      expect(provider).toMatchObject({ id: 'acme', scope: 'openid email profile', userinfo: true, claims: { role: 'groups', admin: ['admins'] } });
      HUB_SETTINGS.set({ HARNESS_SSO_PROVIDERS: JSON.stringify([{ id: 'a', label: 'A', issuer: 'https://a.example', clientId: 'x' }, { id: 'a', label: 'B', issuer: 'https://b.example', clientId: 'y' }]) });
      expect(() => parseHubSettings()).toThrow(EnvError);
    } finally {
      HUB_SETTINGS.set({ HARNESS_SSO_PROVIDERS: '[]' });
    }
    expect(parseHubSettings().authEnv.HARNESS_SSO_PROVIDERS).toEqual([]);
  });

  it('describes every tunable of every slice, each once', () => {
    const keys = HUB_SETTINGS.describe().map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(Object.values(HUB_ENV).reduce((sum, slice) => sum + slice.describe().length, 0));
  });
});
