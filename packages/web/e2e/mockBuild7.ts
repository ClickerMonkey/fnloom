/**
 * The mock hub's build 7 samples: each system's review, kept in memory. `notes` is installed and waits to go live;
 * every other system is live, and `fs` has a new contract version waiting with its changes. Going live, approving,
 * rejecting, switching items and test calls change what is kept, so the review page can be used end to end.
 */
import {
  mintId, RefusalPage, SystemReview, type GoLiveRequest, type PreviewShot, type ItemRef, type RefusalQuery, type RunId, type SystemName, type SystemStage,
} from '@harness/core';
import { notesManifest, refusal, review } from '../src/admin/test/review.ts';

/** The admin who approves in the samples. */
const ADMIN = 'act_admin';

/** Every system's review, as the hub would answer `systemReview`. */
export class MockReviews {
  readonly #now: () => number;
  readonly #reviews = new Map<SystemName, SystemReview>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /** A system's stage: `notes` starts installed, the rest are live. */
  stage(system: SystemName): SystemStage {
    return this.review(system).stage;
  }

  /** A system's review, made the first time it is asked for. */
  review(system: SystemName): SystemReview {
    const known = this.#reviews.get(system);
    if (known !== undefined) { return known; }
    const made = system === 'notes' ? this.#notes() : this.#live(system);
    this.#reviews.set(system, made);
    return made;
  }

  /** Go live with the reviewed hash and the items kept off; refused when the contract moved since. */
  goLive(request: GoLiveRequest): { stage: SystemStage; hash: string } {
    const current = this.review(request.system);
    if (current.manifest.hash !== request.hash) { throw new Error('The contract changed since it was reviewed. Review it again.'); }
    const live = { version: current.manifest.version, hash: request.hash, grants: current.manifest.grants ?? {}, runtime: [], by: ADMIN, at: this.#now() };
    this.#reviews.set(request.system, SystemReview.parse({ ...current, stage: 'live', live, off: request.off }));
    return { stage: 'live', hash: request.hash };
  }

  /** Approve the pending changes by their hash. */
  approve(request: GoLiveRequest): { hash: string } {
    const current = this.review(request.system);
    const { pending, ...rest } = current;
    if (pending?.hash !== request.hash) { throw new Error('Those changes are no longer waiting.'); }
    const live = { version: pending.version, hash: pending.hash, grants: current.manifest.grants ?? {}, runtime: [], by: ADMIN, at: this.#now() };
    this.#reviews.set(request.system, SystemReview.parse({ ...rest, live, off: request.off }));
    return { hash: pending.hash };
  }

  /** Drop the pending changes; the live version stays. */
  reject(system: SystemName): { ok: boolean } {
    const { pending, ...rest } = this.review(system);
    this.#reviews.set(system, SystemReview.parse(rest));
    return { ok: pending !== undefined };
  }

  /** Switch one item of a system on or off. */
  switchItem(system: SystemName, item: ItemRef, on: boolean): { on: boolean } {
    const current = this.review(system);
    const rest = current.off.filter((off) => off.section !== item.section || off.name !== item.name);
    this.#reviews.set(system, { ...current, off: on ? rest : [...rest, { section: item.section, name: item.name }] });
    return { on };
  }

  /** The system a qualified name belongs to. */
  systemOf(name: string): SystemName | undefined {
    const system = name.split('/')[0];
    return [...this.#reviews.keys()].find((known) => known === system);
  }

  /** A test call: a run id to follow. */
  testCall(): { run: RunId } {
    return { run: mintId('run') };
  }

  /** A page of a system's refusals. */
  refusals(query: RefusalQuery): RefusalPage {
    const system = query.system ?? 'notes';
    const at = this.#now();
    const all = [
      refusal({ id: 'rfs_mode', system, at: at - 4 * 60_000 }),
      refusal({ id: 'rfs_host', system, rule: 'network', attempt: 'evil.example.com:443', detail: 'evil.example.com is not in its network grant', fn: undefined, at: at - 30 * 60_000 }),
      refusal({ id: 'rfs_secret', system, rule: 'secrets', attempt: 'OPENAI_API_KEY', detail: 'it may read only NOTES_TOKEN', fn: undefined, at: at - 3 * 3_600_000 }),
    ];
    return RefusalPage.parse({ items: all.filter((item) => query.rule === undefined || item.rule === query.rule) });
  }

  /**
   * The installed `notes`: both fns with their facts, every test listed, the refusals the refusals page lists, and a
   * drawn picture for each preview shot (as the hub's presigned links would give).
   */
  #notes(): SystemReview {
    const base = review();
    const cost = { min: 0, typical: 0, max: 0, basis: 'free', runs: 12 };
    const facts = [
      { fn: 'notes/find', kind: 'native', mode: 'read', reads: ['notes/Note'], writes: [], uses: ['notes/find'], free: true, registry: [], cost, times: { runs: 12, typical: 180, slow: 420, longest: 900 }, longRunning: false },
      ...base.facts,
    ];
    const tests = base.checks?.tests;
    const cases = [
      ...(tests?.cases ?? []),
      { file: 'notes.test.ts', name: 'lists notes newest first', status: 'passed', duration: 7 },
      { file: 'notes.test.ts', name: 'keeps the folder in config', status: 'passed', duration: 3 },
      { file: 'notes.real.test.ts', name: 'titles a note with a model', status: 'skipped', duration: 0, real: true },
    ];
    const last = this.refusals({ system: base.system }).items;
    const previewUrls = Object.fromEntries((tests?.previews ?? []).map((shot) => [shot.image.hash, drawnShot(shot)]));
    return SystemReview.parse({ ...base, facts, checks: { ...base.checks, tests: { ...tests, cases } }, refusals: { total: last.length, last }, previewUrls });
  }

  /** A live system; `fs` has version 1.1.0 waiting with an added fn, a changed one and wider grants. */
  #live(system: SystemName): SystemReview {
    const manifest = notesManifest(`hash-${system}`, { name: system });
    const at = this.#now();
    const live = { version: manifest.version, hash: manifest.hash, grants: manifest.grants ?? {}, runtime: [], by: ADMIN, at: at - 2 * 86_400_000 };
    const pending = system !== 'fs' ? undefined : {
      version: '1.1.0', hash: 'hash-fs-2', by: 'contract', since: at - 20 * 60_000,
      changes: [
        { section: 'fns', name: 'fs/archive', change: 'added', origin: 'contract', after: { description: 'Archive old notes.', mode: 'write' } },
        { section: 'fns', name: 'fs/find', change: 'changed', origin: 'contract', before: { description: 'Find notes.', tags: ['read'] }, after: { description: 'Find notes by words or tags.', tags: ['read', 'search'] } },
        { section: 'grants', name: 'grants', change: 'changed', origin: 'contract', before: { network: ['api.example.com'] }, after: { network: ['api.example.com', 'cdn.example.com'] } },
      ],
    };
    return SystemReview.parse({
      ...review({ system, manifest }), stage: 'live', live, checks: undefined, refusals: { total: 0, last: [] }, ...(pending === undefined ? {} : { pending }),
    });
  }
}

/** A picture standing in for a preview shot: the component in its state, sized and coloured for its viewport and theme. */
function drawnShot(shot: PreviewShot): string {
  const phone = shot.viewport === 'phone';
  const [width, height] = phone ? [360, 640] : [1280, 800];
  const dark = shot.theme === 'dark';
  const [page, card, ink, faint] = dark ? ['#14161a', '#1f2228', '#e8eaed', '#3a3f48'] : ['#f6f7f9', '#ffffff', '#1d2025', '#dde1e6'];
  const rows = shot.state === 'empty' ? 0 : shot.state === 'long' ? 9 : shot.state === 'typical' ? 4 : 0;
  const pad = phone ? 20 : 48;
  const lines = Array.from({ length: rows }, (_, index) => `<rect x="${pad + 16}" y="${pad + 96 + index * 52}" width="${(width - 2 * pad - 32) * (index % 3 === 2 ? 0.6 : 0.9)}" height="28" rx="6" fill="${faint}"/>`).join('');
  const middle = shot.state === 'loading' ? `<circle cx="${width / 2}" cy="${height / 2}" r="28" fill="none" stroke="#4f7cff" stroke-width="6" stroke-dasharray="120 60"/>`
    : shot.state === 'error' ? `<rect x="${pad + 16}" y="${pad + 96}" width="${width - 2 * pad - 32}" height="56" rx="8" fill="#e5484d" opacity="0.85"/>`
    : shot.state === 'empty' ? `<text x="${width / 2}" y="${height / 2}" font-family="sans-serif" font-size="${phone ? 22 : 30}" fill="${ink}" opacity="0.55" text-anchor="middle">No notes yet</text>` : lines;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${page}"/><rect x="${pad}" y="${pad}" width="${width - 2 * pad}" height="${height - 2 * pad}" rx="14" fill="${card}" stroke="${faint}"/><text x="${pad + 16}" y="${pad + 48}" font-family="sans-serif" font-size="${phone ? 24 : 32}" font-weight="600" fill="${ink}">${shot.component}</text>${middle}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
