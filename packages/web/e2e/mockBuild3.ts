/**
 * The mock hub's build 3 state: auto pair secrets (listed without secrets, revoked by an admin) and the decision-model
 * setting for suggestions with its try-out, so the admin screens show real-looking rows.
 */
import { IDS, InstanceName, QualifiedName, SuggestDecision, SystemName, type ActorId, type AutoPairId, type AutoPairView, type SuggestDecisionView, type SuggestionRecord } from '@harness/core';

const DAY = 86_400_000;

/** Build 3's admin state, answered from memory. */
export class MockBuild3 {
  readonly #now: () => number;
  readonly #owner: () => ActorId;
  #secrets: AutoPairView[];
  #decision: SuggestDecisionView = { value: SuggestDecision.parse({}) };

  constructor(now: () => number, owner: () => ActorId) {
    this.#now = now;
    this.#owner = owner;
    const at = now();
    const secret = (id: string, instance: string, made: number, extra: Partial<AutoPairView>): AutoPairView => ({
      id: IDS.autoPair.parse(id), system: SystemName.parse('fs'), instance: InstanceName.parse(instance), createdBy: IDS.actor.parse('act_admin'), createdAt: at - made * DAY, uses: 0, ...extra,
    });
    this.#secrets = [
      secret('apk_laptop', 'laptop', 12, { expiresAt: at + 78 * DAY, uses: 3, lastUsedAt: at - 2 * DAY }),
      secret('apk_server', 'server', 40, {}),
      secret('apk_old', 'old-desk', 120, { expiresAt: at - 30 * DAY, uses: 1, lastUsedAt: at - 95 * DAY }),
    ];
  }

  autoPairs(system: SystemName | undefined): AutoPairView[] {
    return this.#secrets.filter((s) => system === undefined || s.system === system);
  }

  revoke(id: AutoPairId): { ok: boolean } {
    const found = this.#secrets.find((s) => s.id === id && s.revokedAt === undefined);
    if (found === undefined) { return { ok: false }; }
    this.#secrets = this.#secrets.map((s) => (s.id === id ? { ...s, revokedAt: this.#now() } : s));
    return { ok: true };
  }

  get decision(): SuggestDecisionView {
    return this.#decision;
  }

  setDecision(value: SuggestDecision): SuggestDecisionView {
    this.#decision = { value, setBy: this.#owner(), updatedAt: this.#now() };
    return this.#decision;
  }

  /** A try-out: the shape a decision model's answer takes, used and left out with reasons. */
  preview(): SuggestionRecord {
    const by = this.#decision.value.enabled ? 'decision' : 'score';
    return {
      by, threshold: this.#decision.value.floor,
      items: [
        { used: true, kind: 'fn', name: QualifiedName.parse('fs/read'), score: 0.82 },
        { used: true, kind: 'context', name: QualifiedName.parse('fs/guide'), score: 0.71 },
        { used: false, kind: 'fn', name: QualifiedName.parse('fs/write'), score: 0.44, reason: by === 'decision' ? 'declined' : 'below-threshold', ...(by === 'decision' ? { note: 'the message only reads' } : {}) },
      ],
    };
  }
}
