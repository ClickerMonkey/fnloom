/**
 * Web push (VAPID) with the `web-push` package. The hub signs pushes with its VAPID keys (given in `pushEnv`, or
 * generated into the keys file). A subscription the push service says is gone (404, 410) is removed.
 */
import webpush from 'web-push';
import type { ActorId, Notification, PushSubscription } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { PushService } from './index.ts';

/** VAPID keys and the contact the push services see. */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

/** Sends one push; resolves with the push service's status. Its own interface so tests don't reach the network. */
export interface PushSender {
  send(subscription: PushSubscription, payload: string): Promise<{ status: number }>;
}

/** The status codes that mean a subscription is gone for good. */
const GONE = new Set([404, 410]);
const PAGE = 100;

/** How long a push service keeps an undelivered push, in seconds (web push's unit). */
const PUSH_TTL = 24 * 60 * 60;

/** The `web-push` sender. */
export class WebPushSender implements PushSender {
  readonly #keys: VapidKeys;

  constructor(keys: VapidKeys) {
    this.#keys = keys;
  }

  async send(subscription: PushSubscription, payload: string): Promise<{ status: number }> {
    try {
      const result = await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
        vapidDetails: { subject: this.#keys.subject, publicKey: this.#keys.publicKey, privateKey: this.#keys.privateKey },
        TTL: PUSH_TTL,
      });
      return { status: result.statusCode };
    } catch (error) {
      if (error instanceof webpush.WebPushError) { return { status: error.statusCode }; }
      throw error;
    }
  }
}

/** Make a VAPID key pair. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
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
          return { subscription, status: (await this.#sender.send(subscription, payload)).status };
        } catch (error) {
          this.#onError(error, subscription);
          return { subscription, status: 0 };
        }
      }));
      for (const { subscription, status } of results) {
        if (GONE.has(status)) {
          gone.push(subscription.id);
        } else if (status >= 200 && status < 300) {
          sent += 1;
        } else if (status !== 0) {
          // Refused for now (rate limited, too large, bad keys): reported, and the subscription is kept.
          this.#onError(new Error(`the push service answered ${status}`), subscription);
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    // Removed after paging, so the cursor isn't disturbed.
    for (const id of gone) { await table.remove(id); }
    return { sent, gone: gone.length };
  }
}
