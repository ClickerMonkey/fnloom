/**
 * The `pages` mention: `@` offers the URL being typed and the pages the hub keeps (`hub://resources/web/…`) that match
 * what was typed, searched through the hub as the person mentioning (`ctx.resources.search` on a mention ctx is tied to
 * the hub's mention request, so the system only sees what that person may see). Nothing is remembered here: a kept
 * page's target carries its resource, and the hover card and the LLM's text read it from the hub. Labels and titles
 * never show credential-bearing query parameters.
 */
import { HUB_RESOURCE_ROOT, type MentionHover, type ResourceHit, type ResourceUri } from '@harness/core';
import type { MentionCtx, MentionOption } from '@harness/sdk';
import type { PageTargetValue, PageValue } from '../shared/index.ts';
import { domainOf, labelOf, parseWebUrl, redactUrl } from '../shared/urls.ts';

/** Where the hub keeps the web pages it read: the root a pages search stays inside. */
export const WEB_PAGES_ROOT: ResourceUri = `${HUB_RESOURCE_ROOT}web`;

/** What the mention needs of its ctx: the hub's resources, read as the person, and the log. */
export type PageMentionCtx = Pick<MentionCtx, 'resources' | 'log'>;

/** The hover card, as the provider answers it. */
export type PageHover = Omit<MentionHover, 'value'> & { value?: PageValue };

/** The `Page` value of a URL, as the card's type shows it. */
export function pageValue(url: string, title: string | undefined): PageValue {
  return { url, title: title ?? labelOf(url), domain: domainOf(url) };
}

/** Whether a URI is one of the kept web pages, so a target's `uri` is never read outside them (no `.` or `..` steps out). */
export function isKeptPage(uri: string): uri is ResourceUri {
  if (!uri.startsWith(`${WEB_PAGES_ROOT}/`)) { return false; }
  return uri.slice(WEB_PAGES_ROOT.length + 1).split('/').every((step) => step !== '' && step !== '.' && step !== '..');
}

/** The hits one per page (a page's sections each match), best first, at most `limit`. */
export function pagesOf(hits: readonly ResourceHit[], limit: number): ResourceHit[] {
  const seen = new Set<string>();
  const pages: ResourceHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.uri) || !isKeptPage(hit.uri)) { continue; }
    seen.add(hit.uri);
    pages.push(hit);
    if (pages.length === limit) { break; }
  }
  return pages;
}

/** The pages mention's behaviour. */
export class PageMentions {
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** The URL being typed first, then kept pages matching the text. A failed search still offers the typed URL. */
  async search(query: string, ctx: PageMentionCtx): Promise<MentionOption<PageTargetValue>[]> {
    const typed = parseWebUrl(query);
    const options: MentionOption<PageTargetValue>[] = [];
    if (typed !== undefined) {
      options.push({ label: labelOf(typed), hint: `Read ${redactUrl(typed)}`, icon: 'globe', target: { url: typed.href } });
    }
    const text = query.trim();
    if (text === '' || options.length >= this.#limit) { return options; }
    try {
      const hits = await ctx.resources.search(text, { roots: [WEB_PAGES_ROOT], limit: this.#limit });
      for (const hit of pagesOf(hits, this.#limit - options.length)) {
        options.push({ label: hit.title, hint: hit.preview.slice(0, 80), icon: 'globe', target: { uri: hit.uri, title: hit.title } });
      }
    } catch (error) {
      ctx.log.warn('web.mentions.search_failed', { message: error instanceof Error ? error.message : String(error) });
    }
    return options;
  }

  /** A kept page's card from the hub (`undefined` once it is gone), or a typed URL's card without fetching it. */
  async hover(target: PageTargetValue, ctx: PageMentionCtx): Promise<PageHover | undefined> {
    if ('uri' in target) {
      if (!isKeptPage(target.uri)) { return undefined; }
      const stat = await ctx.resources.stat(target.uri);
      if (stat === undefined) { return undefined; }
      return {
        title: stat.name,
        subtitle: 'A web page the hub keeps',
        fields: stat.modifiedAt === undefined ? [] : [{ label: 'Read', value: new Date(stat.modifiedAt).toISOString().slice(0, 10) }],
        open: { resource: stat.uri, title: stat.name },
      };
    }
    const url = parseWebUrl(target.url);
    if (url === undefined) { return undefined; }
    return {
      title: labelOf(url),
      subtitle: redactUrl(url),
      fields: [{ label: 'Site', value: domainOf(url) }],
      body: 'Not read yet. Mentioning it lets the assistant read it with web/read.',
      open: { url: url.href, title: labelOf(url) },
      value: pageValue(url.href, undefined),
    };
  }

  /** How the LLM reaches the page: the kept resource, or `web/read` for a URL. */
  llm(target: PageTargetValue): Promise<string> {
    if ('uri' in target) {
      const named = target.title === undefined ? '' : ` "${target.title}"`;
      return Promise.resolve(isKeptPage(target.uri)
        ? `Web page${named} (the hub resource ${target.uri}). Read it with hub/resource_read ${JSON.stringify({ uri: target.uri })}.`
        : `"${target.uri}" isn't a web page the hub keeps.`);
    }
    const url = parseWebUrl(target.url);
    if (url === undefined) { return Promise.resolve(`"${target.url}" isn't a web address.`); }
    return Promise.resolve(`Web page ${url.href}. Read it with web/read ${JSON.stringify({ url: url.href })}.`);
  }
}
