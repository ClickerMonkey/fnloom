import { describe, expect, it } from 'vitest';
import { HUB_ENV, hubEnv, parseHubSettings } from './env.ts';

describe('hub settings', () => {
  it('parses every slice, with defaults from the schemas', () => {
    const settings = parseHubSettings();
    expect(Object.keys(settings).sort()).toEqual(Object.keys(HUB_ENV).sort());
    expect(settings.queueEnv.HARNESS_TOOL_TIMEOUT).toBeGreaterThan(0);
    expect(settings.modelEnv.HARNESS_EMBED_DIMENSIONS).toBe(768);
  });

  it('derives the public URL from the port unless it is given', () => {
    hubEnv.set('HARNESS_PORT', 4321);
    expect(hubEnv.get('HARNESS_URL')).toBe('http://localhost:4321');
  });

  it('derives the data paths from the data folder', () => {
    hubEnv.set('HARNESS_DATA', 'test-data');
    expect(hubEnv.get('HARNESS_DB_FILE')).toBe('test-data/hub.sqlite');
  });
});
