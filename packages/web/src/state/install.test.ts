/**
 * Installing the app: where it stands on each kind of browser, the kept install prompt shown once, the iPhone sheet,
 * nothing offered once installed or on a page that isn't secure; the offline page only when the network fails; the
 * hub's https and the authority's download address.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeApi, fakeInstall, HTTPS_VIEW } from '../test/fakes.ts';
import { HttpsStore, plainTwin } from './https.ts';
import { BrowserInstall, InstallStore, registerWorker } from './install.ts';
import { OFFLINE_CACHE, OFFLINE_FILES, OFFLINE_PAGE, offlineFallback } from './offline.ts';

describe('the install store', () => {
  it('keeps the browser\'s prompt for its own Install item, shows it once, and stops offering once installed', async () => {
    const browser = fakeInstall();
    const install = new InstallStore(browser);
    expect(install.state.value).toBe('browser');
    expect(install.offered).toBe(false);
    expect(await install.install()).toBe('unavailable');

    browser.offer();
    expect(install.state.value).toBe('ready');
    expect(install.offered).toBe(true);
    browser.state.answer = 'dismissed';
    expect(await install.install()).toBe('dismissed');
    expect(browser.state.prompted).toBe(1);
    // a prompt shows once; the browser offers a new one later
    expect(install.state.value).toBe('browser');

    browser.offer();
    browser.state.answer = 'accepted';
    expect(await install.install()).toBe('accepted');
    browser.installed();
    expect(install.state.value).toBe('installed');
    expect(install.offered).toBe(false);
    install.stop();
  });

  it('opens the sheet on an iPhone, and offers nothing installed or on a page that isn\'t secure', async () => {
    const iphone = new InstallStore(fakeInstall({ ios: true }));
    expect(iphone.state.value).toBe('ios');
    expect(await iphone.install()).toBe('sheet');
    expect(iphone.sheetOpen.value).toBe(true);

    const insecure = new InstallStore(fakeInstall({ secure: false }));
    expect(insecure.state.value).toBe('insecure');
    expect(insecure.secure).toBe(false);
    expect(insecure.offered).toBe(false);
    expect(new InstallStore(fakeInstall({ standalone: true, secure: false })).state.value).toBe('installed');
  });
});

/** A window as far as installing reads it. */
function fakeWindow(options: { agent?: string; touch?: number; modes?: string[]; secure?: boolean; standalone?: boolean } = {}) {
  const target = new EventTarget();
  const media = new Map<string, EventTarget>();
  const win = {
    isSecureContext: options.secure ?? true,
    navigator: { userAgent: options.agent ?? 'Mozilla/5.0 (Windows NT 10.0) Chrome/142', maxTouchPoints: options.touch ?? 0, standalone: options.standalone },
    matchMedia: (query: string) => {
      const listeners = media.get(query) ?? new EventTarget();
      media.set(query, listeners);
      return Object.assign(listeners, { matches: (options.modes ?? []).some((mode) => query === `(display-mode: ${mode})`) });
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  return { win, target };
}

describe('the browser install platform', () => {
  const browser = (options: Parameters<typeof fakeWindow>[0]): BrowserInstall => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake window with only what installing reads
    return new BrowserInstall(fakeWindow(options).win as unknown as Window);
  };

  it('reads installed, secure and iPhone from the window', () => {
    expect(browser({}).standalone()).toBe(false);
    expect(browser({ modes: ['standalone'] }).standalone()).toBe(true);
    expect(browser({ modes: ['window-controls-overlay'] }).standalone()).toBe(true);
    expect(browser({ standalone: true }).standalone()).toBe(true);
    expect(browser({ secure: false }).secure()).toBe(false);
    expect(browser({ agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari' }).ios()).toBe(true);
    // iPadOS says it is a Mac, with a touch screen
    expect(browser({ agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', touch: 5 }).ios()).toBe(true);
    expect(browser({ agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari' }).ios()).toBe(false);
  });

  it('keeps the install prompt from the browser\'s own bar, and hears the app installed', () => {
    const { win, target } = fakeWindow();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake window with only what installing reads
    const platform = new BrowserInstall(win as unknown as Window);
    const prompts: unknown[] = [];
    const changes = vi.fn();
    const stopPrompt = platform.onPrompt((prompt) => { prompts.push(prompt); });
    const stopChange = platform.onChange(changes);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: () => Promise.resolve(), userChoice: Promise.resolve({ outcome: 'accepted' }) });
    target.dispatchEvent(event);
    target.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    expect(prompts).toEqual([event]);
    expect(event.defaultPrevented).toBe(true);
    target.dispatchEvent(new Event('appinstalled'));
    expect(changes).toHaveBeenCalledTimes(1);
    stopPrompt();
    stopChange();
    target.dispatchEvent(event);
    target.dispatchEvent(new Event('appinstalled'));
    expect(prompts).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('registers the service worker only on a secure page', async () => {
    const register = vi.fn(() => Promise.resolve());
    const make = (secure: boolean): Window => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake window with only what registering reads
      return { isSecureContext: secure, navigator: { serviceWorker: { register } } } as unknown as Window;
    };
    await registerWorker(make(false), '/sw.js');
    expect(register).not.toHaveBeenCalled();
    await registerWorker(make(true), '/sw.js');
    expect(register).toHaveBeenCalledWith('/sw.js', { type: 'module', scope: '/' });
    register.mockImplementationOnce(() => Promise.reject(new Error('no')));
    await expect(registerWorker(make(true), '/sw.js')).resolves.toBeUndefined();
  });
});

describe('the offline page', () => {
  it('answers a page load from the network, and only when the network fails from the offline page', async () => {
    const offline = (): Promise<Response> => Promise.resolve(new Response('offline'));
    expect(await (await offlineFallback(() => Promise.resolve(new Response('app')), offline)).text()).toBe('app');
    // an error page from the hub is still the hub's answer
    expect((await offlineFallback(() => Promise.resolve(new Response('gone', { status: 502 })), offline)).status).toBe(502);
    expect(await (await offlineFallback(() => Promise.reject(new TypeError('Failed to fetch')), offline)).text()).toBe('offline');
    expect(OFFLINE_FILES).toEqual([OFFLINE_PAGE]);
    expect(OFFLINE_CACHE).toMatch(/^harness-offline-v\d+$/);
  });
});

describe('the https store', () => {
  it('loads the hub\'s https, offers the authority only for its own certificate, and lets an admin switch it', async () => {
    const api = fakeApi();
    const https = new HttpsStore(api.https);
    expect(https.authority.value).toBeUndefined();
    await https.load();
    expect(https.view.value).toEqual(HTTPS_VIEW);
    expect(https.authority.value).toBe('/harness-ca.crt');
    const outcome = await https.set(false);
    expect(outcome.ok).toBe(true);
    expect(https.view.value?.on).toBe(false);
    expect(https.authority.value).toBeUndefined();
    expect(plainTwin('https://192.168.50.113:4300/', '/harness-ca.crt')).toBe('http://192.168.50.113:4300/harness-ca.crt');
  });
});
