/**
 * Web push (VAPID) with `@ayepi/push`. The hub signs pushes with its VAPID keys (given in `pushEnv`, or generated
 * into the keys file). A subscription the push service says is gone (404, 410) is removed.
 */
import { WebPush, generateVapidKeys as makeVapidKeys, type PushSender, type VapidDetails, type VapidKeys } from '@ayepi/push';
import type { ActorId, Notification, PushSubscription } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { PushService } from './index.ts';

export type { PushSender } from '@ayepi/push';

const PAGE = 100;

/** How long a push service keeps an undelivered push, in seconds (web push's unit). */
const PUSH_TTL = 24 * 60 * 60;

/** The library's sender, keeping undelivered pushes for a day. */
export function webPushSender(vapid: VapidDetails): PushSender {
  return new WebPush({ vapid, defaults: { ttl: PUSH_TTL } });
}

/** Make a VAPID key pair. */
export function generateVapidKeys(): Promise<VapidKeys> {
  return makeVapidKeys();
}

/** What a push carries to the service worker: enough to show it and open the right place. */
export function pushPayload(notification: Notification): string {
  return JSON.stringify({ id: notification.id, title: notification.title, body: notification.body, link: notification.link, reason: notification.reason });
}

/** Pushes to every browser a user subscribed. */
export class WebPushService implements PushService {
  readonly #store: HubStore;
  readonly #sender: PushSender;
  readonly #publicKey: string;
  readonly #onError: (error: unknown, subscription: PushSubscription) => void;

  constructor(options: { store: HubStore; sender: PushSender; publicKey: string; onError: (error: unknown, subscription: PushSubscription) => void }) {
    this.#store = options.store;
    this.#sender = options.sender;
    this.#publicKey = options.publicKey;
    this.#onError = options.onError;
  }

  publicKey(): string {
    return this.#publicKey;
  }

  async send(user: ActorId, notification: Notification): Promise<{ sent: number; gone: number }> {
    const table = this.#store.table('pushSubscriptions');
    const payload = pushPayload(notification);
    let sent = 0;
    const gone: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await table.find({ where: { user }, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
      const results = await Promise.all(page.items.map(async (subscription) => {
        try {
          return { subscription, result: await this.#sender.send({ endpoint: subscription.endpoint, keys: subscription.keys }, payload) };
        } catch (error) {
          this.#onError(error, subscription);
          return { subscription, result: undefined };
        }
      }));
      for (const { subscription, result } of results) {
        if (result === undefined) { continue; }
        if (result.gone) {
          gone.push(subscription.id);
        } else if (result.ok) {
          sent += 1;
        } else {
          // Refused for now (rate limited, too large, bad keys): reported, and the subscription is kept.
          this.#onError(new Error(`the push service answered ${result.status}`), subscription);
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    // Removed after paging, so the cursor isn't disturbed.
    for (const id of gone) { await table.remove(id); }
    return { sent, gone: gone.length };
  }
}
