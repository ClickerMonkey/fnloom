/** The installed app's manners: outside links open in the browser, and the window's colour follows the theme. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { Theme } from '../state/theme.ts';
import { followThemeColour, openOutsideLinksInBrowser, outsideLink, THEME_COLOURS } from './standalone.ts';

afterEach(() => { document.body.innerHTML = ''; });

/** A link in the page, by its attributes. */
function link(attributes: Record<string, string>): HTMLAnchorElement {
  const a = document.createElement('a');
  for (const [name, value] of Object.entries(attributes)) { a.setAttribute(name, value); }
  a.textContent = 'link';
  document.body.append(a);
  return a;
}

describe('outside links', () => {
  const origin = window.location.origin;

  it('finds a link to another site that would open in the same window', () => {
    expect(outsideLink(link({ href: 'https://example.com/page' }), origin)).toBe('https://example.com/page');
    expect(outsideLink(link({ href: '/chat' }), origin)).toBeUndefined();
    expect(outsideLink(link({ href: 'https://example.com/', target: '_blank' }), origin)).toBeUndefined();
    expect(outsideLink(link({ href: 'https://example.com/file.pdf', download: '' }), origin)).toBeUndefined();
    expect(outsideLink(link({ href: 'mailto:ada@example.com' }), origin)).toBeUndefined();
    const inner = document.createElement('span');
    link({ href: 'https://example.com/inner' }).append(inner);
    expect(outsideLink(inner, origin)).toBe('https://example.com/inner');
    expect(outsideLink(null, origin)).toBeUndefined();
  });

  it('opens them in the browser only while the app runs installed', () => {
    let installed = false;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const stop = openOutsideLinksInBrowser(window, () => installed);
    const a = link({ href: 'https://example.com/' });
    // whether the app's handler kept the click; the test then keeps it anyway, so the page never navigates away
    const kept: boolean[] = [];
    const keep = (event: Event): void => { kept.push(event.defaultPrevented); event.preventDefault(); };
    window.addEventListener('click', keep);
    const click = (): boolean | undefined => { a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); return kept.at(-1); };
    expect(click()).toBe(false);
    installed = true;
    expect(click()).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    stop();
    expect(click()).toBe(false);
    window.removeEventListener('click', keep);
    open.mockRestore();
  });
});

describe('the window colour', () => {
  it('follows the app\'s theme with one theme-color', async () => {
    const theme = ref<Theme>('light');
    const stop = followThemeColour(document, theme);
    const colours = (): string[] => [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute('content') ?? '');
    expect(colours()).toEqual([THEME_COLOURS.light]);
    theme.value = 'dark';
    await nextTick();
    expect(colours()).toEqual([THEME_COLOURS.dark]);
    stop();
  });
});
