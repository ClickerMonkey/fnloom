/**
 * The `pages` mention: `@` offers the URL being typed and pages read recently (by title or address), the hover card
 * shows what is known of a page without fetching it, and the LLM is told how to read it. Labels and titles never
 * show credential-bearing query parameters.
 */
import type { MentionHover, ResourceUri } from '@harness/core';
import type { MentionOption } from '@harness/sdk';
import type { PageTargetValue, PageValue } from '../shared/index.ts';
import { domainOf, labelOf, parseWebUrl, redactUrl } from '../shared/urls.ts';

/** A page read recently. */
export interface RecentPage {
  /** The URL it was asked for. */
  readonly url: string;
  readonly finalUrl: string;
  readonly title: string;
  /** The hub resource it was kept as, once `web/read` imported it. */
  readonly uri: ResourceUri | undefined;
  readonly rendered: boolean;
  readonly at: number;
}

/** The last pages read, newest first, at most `max`. */
export class RecentPages {
  readonly #max: number;
  readonly #pages = new Map<string, RecentPage>();

  constructor(max: number) {
    this.#max = max;
  }

  /** Remember a page (again), newest first; what is already known is kept unless the new record has it. */
  add(page: RecentPage): void {
    if (this.#max === 0) { return; }
    const known = this.#pages.get(page.url);
    this.#pages.delete(page.url);
    this.#pages.set(page.url, { ...page, uri: page.uri ?? known?.uri });
    for (const url of this.#pages.keys()) {
      if (this.#pages.size <= this.#max) { break; }
      this.#pages.delete(url);
    }
  }

  /** The page asked for at `url` or ending up there. */
  get(url: string): RecentPage | undefined {
    return this.#pages.get(url) ?? [...this.#pages.values()].find((page) => page.finalUrl === url);
  }

  /** Every page, newest first. */
  all(): RecentPage[] {
    return [...this.#pages.values()].reverse();
  }
}

/** The `Page` value of a URL, as the card's type shows it. */
export function pageValue(url: string, title: string | undefined): PageValue {
  return { url, title: title ?? labelOf(url), domain: domainOf(url) };
}

/** The pages mention's behaviour. */
export class PageMentions {
  readonly #recent: RecentPages;
  readonly #limit: number;

  constructor(recent: RecentPages, limit: number) {
    this.#recent = recent;
    this.#limit = limit;
  }

  search(query: string): Promise<MentionOption<PageTargetValue>[]> {
    const q = query.trim().toLowerCase();
    const typed = parseWebUrl(query);
    const options: MentionOption<PageTargetValue>[] = [];
    if (typed !== undefined) {
      const known = this.#recent.get(typed.href);
      options.push({ label: known?.title ?? labelOf(typed), hint: known === undefined ? `Read ${redactUrl(typed)}` : domainOf(typed), icon: 'globe', target: { url: typed.href } });
    }
    const matches = this.#recent.all().filter((page) => page.url !== typed?.href && (q === '' || page.title.toLowerCase().includes(q) || page.url.toLowerCase().includes(q)));
    for (const page of matches) {
      options.push({ label: page.title, hint: domainOf(page.finalUrl), icon: 'globe', target: { url: page.url } });
    }
    return Promise.resolve(options.slice(0, this.#limit));
  }

  hover(target: PageTargetValue): Promise<(Omit<MentionHover, 'value'> & { value?: PageValue }) | undefined> {
    const url = parseWebUrl(target.url);
    if (url === undefined) { return Promise.resolve(undefined); }
    const page = this.#recent.get(url.href);
    const shown = redactUrl(page?.finalUrl ?? url.href);
    const fields = [
      { label: 'Site', value: domainOf(url) },
      ...(page === undefined ? [] : [{ label: 'Read', value: page.rendered ? 'Rendered in the browser' : 'Fetched' }]),
    ];
    return Promise.resolve({
      title: page?.title ?? labelOf(url),
      subtitle: shown,
      fields,
      ...(page === undefined ? { body: 'Not read yet. Mentioning it lets the assistant read it with web/read.' } : {}),
      open: page?.uri === undefined ? { url: url.href, title: page?.title ?? labelOf(url) } : { resource: page.uri, title: page.title },
      value: pageValue(url.href, page?.title),
    });
  }

  llm(target: PageTargetValue): Promise<string> {
    const url = parseWebUrl(target.url);
    if (url === undefined) { return Promise.resolve(`"${target.url}" isn't a web address.`); }
    const page = this.#recent.get(url.href);
    const args = JSON.stringify({ url: url.href });
    return Promise.resolve(page?.uri === undefined
      ? `Web page ${url.href}. Read it with web/read ${args}.`
      : `Web page ${url.href} ("${page.title}"), kept as the hub resource ${page.uri}. Read it with hub/resource_read ${JSON.stringify({ uri: page.uri })}, or again with web/read ${args}.`);
  }
}
