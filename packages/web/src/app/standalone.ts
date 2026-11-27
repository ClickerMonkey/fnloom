/**
 * The installed app's manners. A link to another site opens in the browser, not inside the app's window (an
 * installed app has no address bar or back button to leave it with). The window's colour (`theme-color`: the title
 * bar on desktop, the status bar on phones) follows the app's theme, including one picked in Settings.
 */
import { watch, type Ref } from 'vue';
import type { Theme } from '../state/theme.ts';

/** The page background per theme, as the manifest and `index.html` give it. */
export const THEME_COLOURS: Readonly<Record<Theme, string>> = { light: '#f9fafb', dark: '#0c0d10' };

/** The link a click lands on, when it leads to another site in the same window. */
export function outsideLink(target: EventTarget | null, origin: string): string | undefined {
  const anchor = target instanceof Element ? target.closest('a[href]') : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '' || anchor.hasAttribute('download')) { return undefined; }
  const url = new URL(anchor.href, origin);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin ? url.toString() : undefined;
}

/** While the app runs installed, open links to other sites in the browser. Returns the function that stops. */
export function openOutsideLinksInBrowser(win: Window, standalone: () => boolean): () => void {
  const click = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || !standalone()) { return; }
    const href = outsideLink(event.target, win.location.origin);
    if (href === undefined) { return; }
    event.preventDefault();
    win.open(href, '_blank', 'noopener,noreferrer');
  };
  win.document.addEventListener('click', click);
  return () => { win.document.removeEventListener('click', click); };
}

/** Keep the window's colour on the app's theme: one `theme-color`, set from `theme`. */
export function followThemeColour(doc: Document, theme: Readonly<Ref<Theme>>): () => void {
  return watch(theme, (current) => {
    for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) { meta.remove(); }
    const meta = doc.createElement('meta');
    meta.name = 'theme-color';
    meta.content = THEME_COLOURS[current];
    doc.head.append(meta);
  }, { immediate: true });
}
