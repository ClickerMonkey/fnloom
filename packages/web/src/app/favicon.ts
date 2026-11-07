/**
 * The tab's icon: the harness mark, with a dot when something needs the person (the same count the tab title shows),
 * so a background tab says so at a glance. The mark is drawn here once; `public/favicon.svg` is the same mark for the
 * browser's first paint and for pushes.
 */

/** The mark, as an SVG document, with or without the dot. Colours are fixed: a favicon can't read the theme. */
export function faviconSvg(dot: boolean): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="9" fill="#5b5bd6"/>',
    '<g stroke="#fff" stroke-width="2" stroke-linecap="round" opacity="0.7"><path d="M16 16 9 9M16 16l7-7M16 16v8"/></g>',
    '<circle cx="16" cy="16" r="3.5" fill="#fff"/><circle cx="9" cy="9" r="2.3" fill="#fff"/><circle cx="23" cy="9" r="2.3" fill="#fff"/><circle cx="16" cy="24" r="2.3" fill="#fff"/>',
    dot ? '<circle cx="26" cy="26" r="6" fill="#e5484d" stroke="#fff" stroke-width="2"/>' : '',
    '</svg>',
  ].join('');
}

/** The icon as a URL a `<link rel="icon">` takes. */
export function faviconHref(dot: boolean): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(dot))}`;
}

/** Point the document's icon at the mark, with the dot when `dot`. */
export function showFavicon(doc: Document, dot: boolean): void {
  let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) {
    link = doc.createElement('link');
    link.rel = 'icon';
    doc.head.append(link);
  }
  link.type = 'image/svg+xml';
  link.href = faviconHref(dot);
}
