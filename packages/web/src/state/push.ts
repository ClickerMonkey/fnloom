/**
 * Web push on this device: whether the browser can do it, whether it is on, and turning it on (the service worker,
 * the browser's permission, a subscription to the hub's VAPID key, sent to the hub) or off. The browser sits behind
 * `PushPlatform`, so the store is tested with a fake one. A push the hub sends is shown by the service worker
 * (`packages/web/sw/sw.ts`); clicking it opens the app at that inbox item (`pushOpenPath` in `push-payload.ts`).
 */
import { ref } from 'vue';
import { z } from 'zod';
import type { NotificationsApi } from '../api/notifications.ts';
import { problemText } from './problems.ts';

/** A browser subscription as the hub takes it. */
export interface PushKeys {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** The browser's side of web push. */
export interface PushPlatform {
  /** Whether this browser can receive pushes here (a service worker, the Push API, a secure page). */
  supported(): boolean;
  /** The person's choice so far. */
  permission(): NotificationPermission;
  /** This device's subscription, if it has one. */
  current(): Promise<PushKeys | undefined>;
  /** Ask permission if needed, then subscribe with the hub's public key. Undefined when the person says no. */
  subscribe(publicKey: string): Promise<PushKeys | undefined>;
  /** Drop this device's subscription. */
  unsubscribe(): Promise<void>;
}

/** Where push stands on this device. */
export type PushState = 'unsupported' | 'off' | 'on' | 'blocked';

/** Web push on this device. */
export class PushStore {
  readonly #api: Pick<NotificationsApi, 'pushKey' | 'subscribePush'>;
  readonly #platform: PushPlatform;
  readonly #device: () => string;
  readonly state = ref<PushState>('off');
  readonly busy = ref(false);
  readonly problem = ref('');

  constructor(api: Pick<NotificationsApi, 'pushKey' | 'subscribePush'>, platform: PushPlatform, device: () => string) {
    this.#api = api;
    this.#platform = platform;
    this.#device = device;
  }

  /** Read where push stands. */
  async check(): Promise<void> {
    if (!this.#platform.supported()) { this.state.value = 'unsupported'; return; }
    if (this.#platform.permission() === 'denied') { this.state.value = 'blocked'; return; }
    this.state.value = (await this.#platform.current().catch(() => undefined)) === undefined ? 'off' : 'on';
  }

  /** Turn push on: subscribe and tell the hub. */
  async enable(): Promise<boolean> {
    if (this.state.value === 'unsupported') { return false; }
    this.busy.value = true;
    this.problem.value = '';
    try {
      const { publicKey } = await this.#api.pushKey.call();
      const keys = await this.#platform.subscribe(publicKey);
      if (keys === undefined) {
        this.state.value = this.#platform.permission() === 'denied' ? 'blocked' : 'off';
        return false;
      }
      await this.#api.subscribePush.call({ endpoint: keys.endpoint, keys: { p256dh: keys.keys.p256dh, auth: keys.keys.auth }, device: this.#device() });
      this.state.value = 'on';
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't turn on notifications.");
      return false;
    } finally {
      this.busy.value = false;
    }
  }

  /** Turn push off on this device. The hub drops a subscription once the browser's push service says it is gone. */
  async disable(): Promise<void> {
    this.busy.value = true;
    try {
      await this.#platform.unsubscribe();
      this.state.value = 'off';
    } finally {
      this.busy.value = false;
    }
  }
}

/** The service worker's URL: built to `/sw.js`, served from source while developing (the composition root picks). */
export const SERVICE_WORKERS = { built: '/sw.js', source: '/sw/sw.ts' } as const;

/** A key as the Push API wants it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }
  return bytes;
}

/** A subscription's keys, read through their schema. */
const SubscriptionJson = z.object({ endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }) });

/** Web push in this browser window. */
export class BrowserPush implements PushPlatform {
  readonly #win: Window;
  readonly #worker: string;

  constructor(win: Window, worker: string) {
    this.#worker = worker;
    this.#win = win;
  }

  supported(): boolean {
    return this.#win.isSecureContext && 'serviceWorker' in this.#win.navigator && 'PushManager' in this.#win && 'Notification' in this.#win;
  }

  permission(): NotificationPermission {
    return Notification.permission;
  }

  async current(): Promise<PushKeys | undefined> {
    const registration = await this.#win.navigator.serviceWorker.getRegistration(this.#worker);
    const subscription = await registration?.pushManager.getSubscription();
    return subscription === null || subscription === undefined ? undefined : SubscriptionJson.parse(subscription.toJSON());
  }

  async subscribe(publicKey: string): Promise<PushKeys | undefined> {
    if ((await Notification.requestPermission()) !== 'granted') { return undefined; }
    const registration = await this.#win.navigator.serviceWorker.register(this.#worker, { type: 'module', scope: '/' });
    await this.#win.navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    return SubscriptionJson.parse(subscription.toJSON());
  }

  async unsubscribe(): Promise<void> {
    const registration = await this.#win.navigator.serviceWorker.getRegistration(this.#worker);
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  }
}
