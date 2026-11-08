import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codePathsOf, indexPage, stage, swap, type GalleryManifest } from './gallery.ts';

describe('the screenshot gallery', () => {
  it('ties each feature to its ui-test and the web folders it covers, else the whole web app', () => {
    expect(codePathsOf('context-graph')).toEqual(['ui-tests/features/context-graph.ts', 'packages/web/src/context']);
    expect(codePathsOf('admin-runs')).toEqual(['ui-tests/features/admin-runs.ts', 'packages/web/src/admin', 'packages/web/src/pages']);
    expect(codePathsOf('themes')).toEqual(['ui-tests/features/themes.ts', 'packages/web/src']);
  });

  it('lists outdated and failed features first and flags them', () => {
    const shot = { commit: 'abc1234', shots: ['x/phone-start.png'], problems: [] };
    const manifest: GalleryManifest = { features: {
      fresh: { id: 'fresh', shotAt: 200, ...shot },
      stale: { id: 'stale', shotAt: 100, ...shot },
      broke: { id: 'broke', shotAt: 300, ...shot, failed: 'after "start": timeout' },
    } };
    const page = indexPage(manifest, (id) => (id === 'stale' ? 150 : 0), 400);
    expect(page).toContain('3 features · 1 outdated');
    expect(page.indexOf('id="fresh"')).toBeGreaterThan(Math.max(page.indexOf('id="stale"'), page.indexOf('id="broke"')));
    expect(page).toContain('outdated: code changed since');
    expect(page).toContain('failed: after &quot;start&quot;: timeout');
  });
});

describe('staging and swapping the gallery', () => {
  it('replaces the features a run reached, keeps the rest, keeps a failed one\'s old shots, and swaps whole', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-gallery-'));
    try {
      const gallery = join(root, 'gallery');
      const shots = join(root, 'shots');
      for (const [dir, file] of [[join(gallery, 'kept'), 'phone-a.png'], [join(gallery, 'broke'), 'phone-old.png'], [join(shots, 'themes'), 'phone-new.png']] as const) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, file), 'png');
      }
      const old = { commit: 'c0', shotAt: 1, problems: [] };
      writeFileSync(join(gallery, 'gallery.json'), JSON.stringify({ features: { kept: { id: 'kept', shots: ['kept/phone-a.png'], ...old }, broke: { id: 'broke', shots: ['broke/phone-old.png'], ...old } } }));
      writeFileSync(join(shots, 'report.json'), JSON.stringify([
        { feature: 'themes', shots: [join(shots, 'themes', 'phone-new.png')], problems: [] },
        { feature: 'broke', shots: [], problems: [], error: 'boom' },
      ]));
      const manifest = stage(gallery, `${gallery}.staging`, 50, shots);
      swap(gallery, `${gallery}.staging`);
      expect(manifest.features['themes']).toMatchObject({ shotAt: 50, shots: ['themes/phone-new.png'] });
      expect(manifest.features['broke']).toMatchObject({ shotAt: 1, shots: ['broke/phone-old.png'], failed: 'boom' });
      expect(manifest.features['kept']?.shotAt).toBe(1);
      expect(['kept/phone-a.png', 'broke/phone-old.png', 'themes/phone-new.png'].every((f) => existsSync(join(gallery, f)))).toBe(true);
      expect(existsSync(`${gallery}.staging`) || existsSync(`${gallery}.old`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
