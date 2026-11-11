/**
 * The web system's server. Its parts sit behind these interfaces so tests run the implementation with fakes (a fake
 * `fetch`, DNS, browser and search): `SearchProvider` (Tavily), `PageSource` (fetching a URL, with rendering) and
 * `ContentUploads` (handing fetched bytes to the hub). `createWebImpl` wires them to the contract.
 */
import type { ResolveOptions, ResourceRegistry } from '@aeye/resources';
import type { ContentRef } from '@harness/core';
import type { ConfigOf, TypesOf } from '@harness/sdk';
import type { RenderModeValue, SearchFoundValue, WebContract } from '../shared/index.ts';

/** The web system's config. */
export type WebConfig = ConfigOf<WebContract['defs']>;

/** The args of `web/search`. */
export type SearchArgs = TypesOf<WebContract['defs']['fns']['search']>['args'];

/** Searches the web. */
export interface SearchProvider {
  /** Results for the args, best first. Throws `WebProblem` (`no-search-key`, `search-refused`, …). */
  search(args: SearchArgs, options: { key: string | undefined; signal?: AbortSignal }): Promise<SearchFoundValue>;
}

/** How one fetch behaves: the config's values where it has them, the system's settings otherwise. */
export interface FetchSettings {
  readonly render: RenderModeValue;
  readonly allowPrivate: boolean;
  readonly maxBytes: number;
  readonly timeout: number;
}

/** A fetched URL. */
export interface FetchedPage {
  /** The content: as served for binary, utf-8 for text (and the rendered html for a rendered page). */
  readonly bytes: Uint8Array;
  readonly mime: string;
  /** The type `@aeye/resources` detected (`html`, `pdf`, …), when it found one. */
  readonly type: string | undefined;
  /** The URL asked for, normalised (`example.com` becomes `https://example.com/`). */
  readonly requestedUrl: string;
  /** Where the content came from after redirects (and the browser's navigation). */
  readonly finalUrl: string;
  readonly status: number;
  /** Whether the headless browser rendered it. */
  readonly rendered: boolean;
  /** Why rendering failed under `auto` (the fetched html was kept). */
  readonly renderError: string | undefined;
  /** Its title, or a label from its URL with credentials redacted. */
  readonly title: string;
}

/** Fetches URLs. */
export interface PageSource {
  /** Throws `WebProblem` for a bad URL, a refused address, a failed status, a timeout or a body over the limit. */
  fetch(url: string, settings: FetchSettings, signal?: AbortSignal): Promise<FetchedPage>;
  /**
   * What `@aeye/resources`' graph walks a site with: the registry, and the options every page is fetched with under
   * these settings (the guarded fetch, the renderer, the limits), calling `before` ahead of each request (a crawl
   * checks robots.txt there; throwing refuses the request).
   */
  crawling(settings: FetchSettings, signal: AbortSignal, before: (url: URL) => Promise<void>): { registry: ResourceRegistry; options: ResolveOptions };
}

/** Hands fetched bytes to the hub for the run that fetched them. */
export interface ContentUploads {
  /** Upload bytes for the run whose signal this is; returns their ref. */
  upload(signal: AbortSignal, bytes: Uint8Array, mime: string): Promise<ContentRef>;
}

export { web } from '../shared/index.ts';
