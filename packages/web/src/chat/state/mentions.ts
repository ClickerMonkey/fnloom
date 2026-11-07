/**
 * Mention hover cards, fetched live from the mention's system and kept briefly (the caller caches too), so hovering
 * the same chip again is instant. A thing that no longer exists, or a system that is offline, reads as unavailable.
 */
import type { Json, MentionHover, QualifiedName, SessionId } from '@harness/core';
import { shallowRef } from 'vue';
import { problemText } from '../../state/problems.ts';
import type { ChatApi } from '../api.ts';

/** A card as shown. */
export interface MentionCard {
  readonly loading: boolean;
  readonly hover: MentionHover | undefined;
  readonly problem: string;
}

/** The key of a mention's card. */
export const cardKey = (provider: QualifiedName, target: Json): string => `${provider}:${JSON.stringify(target)}`;

/** Hover cards by mention. */
export class MentionCards {
  readonly #api: Pick<ChatApi, 'mentionHover'>;
  readonly cards = shallowRef<ReadonlyMap<string, MentionCard>>(new Map());

  constructor(api: Pick<ChatApi, 'mentionHover'>) {
    this.#api = api;
  }

  /** The card of a mention, as far as loaded. */
  card(provider: QualifiedName, target: Json): MentionCard {
    return this.cards.value.get(cardKey(provider, target)) ?? { loading: true, hover: undefined, problem: '' };
  }

  /** Fetch a mention's card (again only if it failed before). */
  async load(session: SessionId, provider: QualifiedName, target: Json): Promise<void> {
    const key = cardKey(provider, target);
    const known = this.cards.value.get(key);
    if (known !== undefined && (known.loading || known.problem === '')) { return; }
    this.#set(key, { loading: true, hover: undefined, problem: '' });
    try {
      const { hover } = await this.#api.mentionHover.call({ session, provider, target });
      this.#set(key, { loading: false, hover, problem: '' });
    } catch (error) {
      this.#set(key, { loading: false, hover: undefined, problem: problemText(error, 'Not available right now.') });
    }
  }

  #set(key: string, card: MentionCard): void {
    const cards = new Map(this.cards.value);
    cards.set(key, card);
    this.cards.value = cards;
  }
}
