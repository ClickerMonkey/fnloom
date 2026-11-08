import { describe, expect, it } from 'vitest';
import { GlobSecrets } from './secrets.ts';

describe('GlobSecrets', () => {
  it('hides env files, keys and credentials by default, but serves the env example', () => {
    const secrets = new GlobSecrets();
    for (const path of ['.env', 'app/.env.local', 'certs/site.pem', 'tls.key', '.ssh/id_ed25519', '.ssh/id_rsa.pub', 'a.pfx', 'b.p12', '.npmrc', 'aws/credentials', 'gcp.credentials.json', '.secret.pem', 'certs/.server.key', '.cert.pfx']) {
      expect(secrets.hides(path), path).toBe(true);
    }
    for (const path of ['.env.example', 'src/env.ts', 'src/id_map.ts', 'docs/keys.md', 'README.md', '']) {
      expect(secrets.hides(path), path).toBe(false);
    }
  });

  it('hides what is inside a hidden folder, and follows a configured list (last match wins, empty turns it off)', () => {
    const secrets = new GlobSecrets(['vault', 'config/*.yml', '!config/public.yml']);
    expect(secrets.hides('vault/a.txt')).toBe(true);
    expect(secrets.hides('config/db.yml')).toBe(true);
    expect(secrets.hides('config/public.yml')).toBe(false);
    expect(secrets.hides('.env')).toBe(false);
    expect(new GlobSecrets([]).hides('.env')).toBe(false);
  });
});
