/**
 * The page host for the parts under a Claude page (`inject(PAGE_HOST)`): the same host the page gets as `host`, so a
 * row links to a session and draws with the app's components without each part being handed them.
 */
import { PAGE_HOST, type PageHost } from '@harness/sdk';
import { inject } from 'vue';

/** The page's host; throws outside a system page. */
export function usePageHost(): PageHost {
  const host = inject(PAGE_HOST);
  if (host === undefined) { throw new Error('a Claude page part needs the page host (PAGE_HOST)'); }
  return host;
}

/**
 * Whether a click on a link is a plain one, which the page handles by moving itself (`host.go`); a click that opens a
 * new tab or window keeps the link's own way. A plain click's default is prevented.
 */
export function plainClick(event: MouseEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) { return false; }
  event.preventDefault();
  return true;
}
