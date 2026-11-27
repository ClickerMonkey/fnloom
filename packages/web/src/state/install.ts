/**
 * Installing the app on this device. Chrome, Edge and Android offer an install prompt (`beforeinstallprompt`), which
 * is kept so the app's own **Install app** item can show it; iPhones and iPads install from Safari's Share menu ("Add
 * to Home Screen"), which the app explains in a short sheet; elsewhere the browser's own menu does it. Nothing is
 * offered once the app runs installed (`display-mode: standalone`), and nothing can install on a page that isn't
 * secure (http on another device): that also blocks notifications, so Settings says how to fix it. The browser sits
 * behind `InstallPlatform`, so the store is tested with a fake one.
 */
import { ref } from 'vue';

/** The browser's install prompt, kept from `beforeinstallprompt`. */
export interface InstallPrompt {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** The browser's side of installing. */
export interface InstallPlatform {
  /** Whether the page runs as an installed app now. */
  standalone(): boolean;
  /** Whether the page is a secure context (https, or this computer). */
  secure(): boolean;
  /** Whether this is an iPhone or iPad, which installs with Share › Add to Home Screen. */
  ios(): boolean;
  /** Hear the browser offer its install prompt; returns the function that stops. */
  onPrompt(listener: (prompt: InstallPrompt) => void): () => void;
  /** Hear the app installed, or the display mode change. */
  onChange(listener: () => void): () => void;
}

/**
 * Where installing stands: `installed` (running installed), `ready` (the browser's prompt is there), `ios` (Add to
 * Home Screen), `insecure` (the page isn't secure, so nothing can install), `browser` (the browser's own menu, when it
 * has one; it offered no prompt).
 */
export type InstallState = 'installed' | 'ready' | 'ios' | 'insecure' | 'browser';

/** Installing the app on this device. */
export class InstallStore {
  readonly #platform: InstallPlatform;
  #prompt: InstallPrompt | undefined;
  readonly #stops: (() => void)[] = [];
  readonly state = ref<InstallState>('browser');
  /** The iPhone sheet (Share › Add to Home Screen) is open. */
  readonly sheetOpen = ref(false);
  /** Whether the page is secure (installing and notifications need it). */
  readonly secure: boolean;

  constructor(platform: InstallPlatform) {
    this.#platform = platform;
    this.secure = platform.secure();
    this.#read();
    this.#stops.push(
      platform.onPrompt((prompt) => { this.#prompt = prompt; this.#read(); }),
      platform.onChange(() => { this.#prompt = undefined; this.#read(); }),
    );
  }

  /** Whether the account menu offers **Install app**: only when one tap does it (a prompt, or the iPhone sheet). */
  get offered(): boolean {
    return this.state.value === 'ready' || this.state.value === 'ios';
  }

  #read(): void {
    const p = this.#platform;
    this.state.value = p.standalone() ? 'installed' : !p.secure() ? 'insecure' : this.#prompt !== undefined ? 'ready' : p.ios() ? 'ios' : 'browser';
  }

  /** Install: the browser's prompt, or the iPhone sheet. Resolves with what the person chose. */
  async install(): Promise<'accepted' | 'dismissed' | 'sheet' | 'unavailable'> {
    if (this.state.value === 'ios') { this.sheetOpen.value = true; return 'sheet'; }
    const prompt = this.#prompt;
    if (this.state.value !== 'ready' || prompt === undefined) { return 'unavailable'; }
    // a prompt shows once: the browser offers a new one later if the person said no
    this.#prompt = undefined;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    this.#read();
    return outcome;
  }

  /** Stop listening (tests). */
  stop(): void {
    for (const stop of this.#stops.splice(0)) { stop(); }
  }
}

/** The display modes an installed app runs in. */
const INSTALLED_MODES = ['standalone', 'window-controls-overlay', 'minimal-ui', 'fullscreen'] as const;

/** Installing in this browser window. */
export class BrowserInstall implements InstallPlatform {
  readonly #win: Window;

  constructor(win: Window) {
    this.#win = win;
  }

  standalone(): boolean {
    // Safari on iPhone says so on navigator; everything else by the display mode
    const nav: Navigator & { standalone?: boolean } = this.#win.navigator;
    return nav.standalone === true || INSTALLED_MODES.some((mode) => this.#win.matchMedia(`(display-mode: ${mode})`).matches);
  }

  secure(): boolean {
    return this.#win.isSecureContext;
  }

  ios(): boolean {
    const nav = this.#win.navigator;
    // iPadOS says it is a Mac; a Mac has no touch screen
    return /iPhone|iPad|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
  }

  onPrompt(listener: (prompt: InstallPrompt) => void): () => void {
    const handle = (event: Event): void => {
      if (!isInstallPrompt(event)) { return; }
      // keep it for the app's own Install item instead of the browser's mini bar
      event.preventDefault();
      listener(event);
    };
    this.#win.addEventListener('beforeinstallprompt', handle);
    return () => { this.#win.removeEventListener('beforeinstallprompt', handle); };
  }

  onChange(listener: () => void): () => void {
    const queries = INSTALLED_MODES.map((mode) => this.#win.matchMedia(`(display-mode: ${mode})`));
    for (const query of queries) { query.addEventListener('change', listener); }
    this.#win.addEventListener('appinstalled', listener);
    return () => {
      for (const query of queries) { query.removeEventListener('change', listener); }
      this.#win.removeEventListener('appinstalled', listener);
    };
  }
}

/** Whether an event is the browser's install prompt (it has `prompt` and `userChoice`). */
function isInstallPrompt(event: Event): event is Event & InstallPrompt {
  return 'prompt' in event && typeof event.prompt === 'function' && 'userChoice' in event;
}

/** Register the service worker (push, and the offline page) when the page can have one. */
export async function registerWorker(win: Window, url: string): Promise<void> {
  if (!win.isSecureContext || !('serviceWorker' in win.navigator)) { return; }
  try {
    await win.navigator.serviceWorker.register(url, { type: 'module', scope: '/' });
  } catch {
    // no offline page then; the app works as it did
  }
}
