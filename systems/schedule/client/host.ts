/**
 * The page host for the parts under a schedule page (`inject(PAGE_HOST)`), and how their links move: a plain click is
 * handled by the page (`host.go`, `host.goRun`), a click that opens a new tab keeps the link's own way.
 */
import { PAGE_HOST, type PageHost } from '@harness/sdk';
import { inject } from 'vue';
import type { EntryTarget } from './logic.ts';

/** The page's host; throws outside a system page. */
export function usePageHost(): PageHost {
  const host = inject(PAGE_HOST);
  if (host === undefined) { throw new Error('a schedule page part needs the page host (PAGE_HOST)'); }
  return host;
}

/** Whether a click on a link is a plain one, which the page handles itself; a plain click's default is prevented. */
export function plainClick(event: MouseEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) { return false; }
  event.preventDefault();
  return true;
}

/** The URL of where an entry leads (its run's page, or the schedule's page at that firing). */
export function targetHref(host: PageHost, target: EntryTarget): string {
  return 'run' in target ? host.runHref(target.run) : host.href(target);
}

/** Go where an entry leads. */
export function goTarget(host: PageHost, target: EntryTarget): void {
  if ('run' in target) { host.goRun(target.run); } else { host.go(target); }
}
