/**
 * `npm run gallery`: the screenshot gallery. Runs the UI features (`ui-tests/run.ts`, or `ui-tests/mock.ts` with
 * `HARNESS_GALLERY_MOCK`), stages their shots with the gallery's other features in a folder of its own, and swaps the
 * staged gallery in only once it is whole, so a run that stops halfway leaves the last gallery as it was. Per
 * feature it records the commit and the time of its shots; `index.html` shows every feature's shots and flags those
 * older than the feature's code (its ui-test and the web folders it covers, committed or not).
 *
 *   HARNESS_UI_URL=… HARNESS_UI_EMAIL=… HARNESS_UI_PASSWORD=… HARNESS_UI_ONLY=chat-shell npm run gallery
 *   HARNESS_GALLERY_MOCK=true HARNESS_UI_ONLY=context-graph npm run gallery   # against the mock hub
 *   HARNESS_GALLERY_INDEX_ONLY=true npm run gallery                            # re-flag outdated shots, run nothing
 *
 * A feature that failed keeps its previous shots (flagged as failed in the last run). `HARNESS_UI_ONLY` and
 * `HARNESS_UI_VIEWPORTS` pass through to the runner; a full run takes about half an hour.
 */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '@ayepi/env';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Where `ui-tests/run.ts` writes its shots and report. */
const SHOTS = join(ROOT, 'ui-tests', 'shots');

const galleryEnv = env({
  /** The gallery folder (gitignored). */
  HARNESS_GALLERY_DIR: z.string().default('ui-tests/gallery'),
  /** Run against the web app's mock hub (`ui-tests/mock.ts`) instead of the stack at `HARNESS_UI_URL`. */
  HARNESS_GALLERY_MOCK: z.boolean().default(false),
  /** Only rewrite the index (re-flag outdated shots); run nothing. */
  HARNESS_GALLERY_INDEX_ONLY: z.boolean().default(false),
});

/** One feature's entry in the gallery. */
export const GalleryFeature = z.object({
  id: z.string(),
  /** The commit its shots were taken at, with `+dirty` when its code had uncommitted changes. */
  commit: z.string(),
  /** When its shots were taken (ms since the epoch). */
  shotAt: z.number(),
  /** Shot files, relative to the gallery folder. */
  shots: z.array(z.string()),
  /** Layout problems the last run found in them. */
  problems: z.array(z.string()),
  /** Set when the last run of the feature failed: its shots are from the run before. */
  failed: z.string().optional(),
});
export type GalleryFeature = z.infer<typeof GalleryFeature>;

/** `gallery.json`: every feature in the gallery, by id. */
export const GalleryManifest = z.object({ features: z.record(z.string(), GalleryFeature) });
export type GalleryManifest = z.infer<typeof GalleryManifest>;

/** What `ui-tests/run.ts` writes to `report.json`: one result per feature and viewport. */
const RunReport = z.array(z.object({
  feature: z.string(),
  shots: z.array(z.string()),
  problems: z.array(z.object({ rule: z.string(), detail: z.string() })),
  error: z.string().optional(),
}));

/**
 * The web folders each feature covers besides its own ui-test, by the first rule its id matches; a feature no rule
 * names covers the whole web app (the shell, themes and other features that touch everything).
 */
const FEATURE_CODE: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^(admin-resources|resource-browser|viewers)$/, ['packages/web/src/resources']],
  [/^context-/, ['packages/web/src/context']],
  [/^gin-editors$/, ['packages/web/src/gin']],
  [/^(admin-|instances$|pairing$|qr-pairing$|people$|model-|hub-mcps$|fn-metrics$|budget$)/, ['packages/web/src/admin', 'packages/web/src/pages']],
  [/^(chat-|composer$|commands$|mentions$|message-|streaming$|run-|turn-|reasoning$|suggestions$|attachments$|uploads$|approvals$|fn-display$|invoke$|undo$|live-runs$|drawer-live$|markdown$|renderers$|scrolling$|timestamps$|invalid-input$|session-settings$)/, ['packages/web/src/chat']],
];

/** The paths whose changes outdate a feature's shots: its ui-test and the web folders it covers. */
export function codePathsOf(id: string): string[] {
  const covered = FEATURE_CODE.find(([rule]) => rule.test(id))?.[1] ?? ['packages/web/src'];
  return [`ui-tests/features/${id}.ts`, ...covered];
}

/** `git` in the repo, its output trimmed. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Files under `paths` with uncommitted changes. */
function dirtyFiles(paths: readonly string[]): string[] {
  return git('status', '--porcelain', '--untracked-files=all', '--', ...paths).split('\n').filter((line) => line !== '').map((line) => line.slice(3).replace(/^.* -> /, ''));
}

/** When a feature's code last changed: its last commit, or a newer uncommitted file's modification. */
export function codeChangedAt(paths: readonly string[]): number {
  const committed = Number(git('log', '-1', '--format=%ct', '--', ...paths)) * 1000;
  const dirty = dirtyFiles(paths).map((file) => { try { return statSync(join(ROOT, file)).mtimeMs; } catch { return 0; } });
  return Math.max(committed || 0, ...dirty);
}

/** The commit shots are taken at for paths: HEAD, marked when those paths have uncommitted changes. */
function commitOf(paths: readonly string[]): string {
  return `${git('rev-parse', '--short', 'HEAD')}${dirtyFiles(paths).length > 0 ? '+dirty' : ''}`;
}

/** The gallery's manifest, or an empty one. */
function readManifest(folder: string): GalleryManifest {
  const file = join(folder, 'gallery.json');
  return existsSync(file) ? GalleryManifest.parse(JSON.parse(readFileSync(file, 'utf8'))) : { features: {} };
}

/** HTML text, escaped. */
const html = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** The index page: outdated and failed features first, each with its shots. */
export function indexPage(manifest: GalleryManifest, changedAt: (id: string) => number, now: number): string {
  const rows = Object.values(manifest.features).map((f) => ({ f, outdated: changedAt(f.id) > f.shotAt }));
  rows.sort((a, b) => Number(b.outdated || b.f.failed !== undefined) - Number(a.outdated || a.f.failed !== undefined) || a.f.id.localeCompare(b.f.id));
  const outdated = rows.filter((r) => r.outdated).length;
  const sections = rows.map(({ f, outdated: old }) => {
    const flags = [old ? '<b class="old">outdated: code changed since</b>' : '', f.failed === undefined ? '' : `<b class="bad">failed: ${html(f.failed)}</b>`,
      f.problems.length > 0 ? `<b class="bad">${f.problems.length} layout problem(s)</b>` : ''].filter((s) => s !== '').join(' ');
    const shots = f.shots.map((s) => `<a href="${html(s)}"><img loading="lazy" src="${html(s)}" title="${html(s)}"></a>`).join('');
    return `<section id="${html(f.id)}"><h2>${html(f.id)} <small>${html(f.commit)} · ${new Date(f.shotAt).toISOString().slice(0, 16).replace('T', ' ')}</small> ${flags}</h2><div>${shots}</div></section>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>harness UI gallery</title><style>
body{font:14px system-ui;margin:16px;color:#222;background:#fafafa}h1{font-size:18px}h2{font-size:15px;margin:16px 0 6px}small{color:#777;font-weight:400}
b{font-size:12px;padding:1px 6px;border-radius:8px;margin-left:6px}.old{background:#fde68a}.bad{background:#fecaca}
div{display:flex;gap:6px;overflow-x:auto}img{height:180px;border:1px solid #ddd;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}img{border-color:#333}.old,.bad{color:#111}}</style>
<h1>UI gallery · ${rows.length} features · ${outdated} outdated · written ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}</h1>
${sections.join('\n')}`;
}

/** Run the UI features; resolves with the runner's exit code. */
function runFeatures(mock: boolean): Promise<number> {
  const runner = join(ROOT, 'ui-tests', mock ? 'mock.ts' : 'run.ts');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', runner], { cwd: ROOT, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => { resolve(code ?? 1); });
  });
}

/**
 * Stage the gallery: the previous gallery's features, with those the run reached replaced by their new shots (a
 * failed one keeps its old shots and is marked failed). Returns the staged manifest.
 */
export function stage(gallery: string, staging: string, now: number, shots = SHOTS): GalleryManifest {
  const previous = readManifest(gallery);
  rmSync(staging, { recursive: true, force: true });
  if (existsSync(gallery)) { cpSync(gallery, staging, { recursive: true }); } else { mkdirSync(staging, { recursive: true }); }
  const report = RunReport.parse(JSON.parse(readFileSync(join(shots, 'report.json'), 'utf8')));
  const features = { ...previous.features };
  for (const id of new Set(report.map((r) => r.feature))) {
    const results = report.filter((r) => r.feature === id);
    const error = results.find((r) => r.error !== undefined)?.error;
    const before = features[id];
    if (error !== undefined) {
      features[id] = { ...(before ?? { id, commit: '', shotAt: 0, shots: [], problems: [] }), failed: error };
      continue;
    }
    rmSync(join(staging, id), { recursive: true, force: true });
    cpSync(join(shots, id), join(staging, id), { recursive: true });
    features[id] = {
      id, commit: commitOf(codePathsOf(id)), shotAt: now,
      shots: results.flatMap((r) => r.shots).map((file) => relative(shots, file).split(sep).join('/')),
      problems: results.flatMap((r) => r.problems.map((p) => `${p.rule}: ${p.detail}`)),
    };
  }
  return { features };
}

/** Swap the staged gallery in: the old one moves aside first and is removed once the new one is in place. */
export function swap(gallery: string, staging: string): void {
  const aside = `${gallery}.old`;
  rmSync(aside, { recursive: true, force: true });
  if (existsSync(gallery)) { renameSync(gallery, aside); }
  renameSync(staging, gallery);
  rmSync(aside, { recursive: true, force: true });
}

/** Write the manifest and the index into a gallery folder. */
function writeGallery(folder: string, manifest: GalleryManifest, now: number): void {
  writeFileSync(join(folder, 'gallery.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(folder, 'index.html'), indexPage(manifest, (id) => codeChangedAt(codePathsOf(id)), now));
}

/** The command. */
async function main(): Promise<void> {
  const settings = galleryEnv.parse();
  const gallery = join(ROOT, settings.HARNESS_GALLERY_DIR);
  const now = Date.now();
  if (settings.HARNESS_GALLERY_INDEX_ONLY) {
    mkdirSync(gallery, { recursive: true });
    writeGallery(gallery, readManifest(gallery), now);
    console.info('gallery.index', { index: join(gallery, 'index.html') });
    return;
  }
  rmSync(join(SHOTS, 'report.json'), { force: true });
  const code = await runFeatures(settings.HARNESS_GALLERY_MOCK);
  if (!existsSync(join(SHOTS, 'report.json'))) {
    console.error('gallery.incomplete', { code, kept: gallery });
    process.exitCode = code === 0 ? 1 : code;
    return;
  }
  const staging = `${gallery}.staging`;
  const manifest = stage(gallery, staging, now);
  writeGallery(staging, manifest, now);
  swap(gallery, staging);
  console.info('gallery.done', { features: Object.keys(manifest.features).length, index: join(gallery, 'index.html'), runner: code });
  process.exitCode = code;
}

// run as the command, not when a test imports the helpers
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await main(); }
