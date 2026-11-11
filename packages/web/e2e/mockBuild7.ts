/**
 * The mock hub's build 7 samples: each system's review, kept in memory. `notes` is installed and waits to go live;
 * every other system is live, and `fs` has a new contract version waiting with its changes. Going live, approving,
 * rejecting, switching items and test calls change what is kept, so the review page can be used end to end.
 */
import {
  mintId, RefusalPage, SystemReview, type GoLiveRequest, type ItemRef, type RefusalQuery, type RunId, type SystemName, type SystemStage,
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
    const made = system === 'notes' ? review() : this.#live(system);
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
