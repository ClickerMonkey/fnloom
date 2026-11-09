/**
 * Web crawls in the resource browser. `web/crawl` keeps every page it reads under one folder named for the site and
 * the time (`…/crawls/<host>-<yyyymmdd-hhmm>/`, UTC). That folder is a root of its own: the tree and the crumbs name
 * it by site and time, and the browser shows what the crawl was and who may use it.
 */

/** A crawl's folder, read from its address. */
export interface CrawlFolder {
  /** The folder's address, ending in `/` (as the tree's values do). */
  readonly root: string;
  /** The site crawled (`docs.example.com`). */
  readonly host: string;
  /** When it ran (ms). */
  readonly at: number;
}

/** `…/crawls/<host>-<yyyymmdd>-<hhmm>/`, the crawl's folder at the end of an address. */
const CRAWL = /^(.*\/crawls\/([a-z0-9.-]+?)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2}))(?:\/|$)/i;

/** The crawl a folder or resource is in, if any: the crawl's own folder, or one inside it. */
export function crawlOf(address: string): CrawlFolder | undefined {
  const match = CRAWL.exec(address);
  if (match === null) { return undefined; }
  const [, root = '', host = '', year, month, day, hour, minute] = match;
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(at) ? undefined : { root: `${root}/`, host, at };
}

/** Whether a folder is a crawl's own folder (not one inside it). */
export function isCrawlRoot(folder: string): boolean {
  return crawlOf(folder)?.root === (folder.endsWith('/') ? folder : `${folder}/`);
}

/** A crawl's name in the tree and the crumbs: its site and when ("docs.example.com · 8 Nov, 14:30"). */
export function crawlLabel(crawl: CrawlFolder, locale?: string): string {
  const date = new Date(crawl.at);
  const day = date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return `${crawl.host} · ${day}, ${time}`;
}
