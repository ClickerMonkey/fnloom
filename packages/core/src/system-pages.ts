/**
 * System pages (item 9): a whole page a system adds to the web app, at `/s/<system>/<segment>`. The contract declares
 * each one (`system({ pages })`, `Manifest.pages`): its URL segment, title, icon, where the nav shows it and who may
 * open it, and the name of the Vue component its client build draws it with (`client({ pages })`). The hub lists the
 * pages of live systems a person may see (`SystemPageView`), so the nav and the routes follow the systems: a page is
 * there while its system is installed and live, and gone when the system is switched off or removed.
 */
import { z } from 'zod';
import { SystemName } from './primitives.ts';

/** A page's URL segment: lowercase letters, digits and dashes, starting with a letter (`sessions`). */
export const PageSegment = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'a page segment is lowercase letters, digits and dashes, starting with a letter (at most 40)');
export type PageSegment = z.infer<typeof PageSegment>;

/**
 * Where a page shows in the nav: `main` in the sidebar with the app's own pages; `hidden` nowhere, reached only by a
 * link (a detail page such as one session).
 */
export const SYSTEM_PAGE_NAVS = ['main', 'hidden'] as const;
export const SystemPageNav = z.enum(SYSTEM_PAGE_NAVS);
export type SystemPageNav = z.infer<typeof SystemPageNav>;

/** Who may open a page: every person who sees the system, or admins only. */
export const SYSTEM_PAGE_ACCESS = ['everyone', 'admin'] as const;
export const SystemPageAccess = z.enum(SYSTEM_PAGE_ACCESS);
export type SystemPageAccess = z.infer<typeof SystemPageAccess>;

/** One page a contract declares (`Manifest.pages`). */
export const SystemPageDecl = z.object({
  segment: PageSegment,
  /** The page's name in the nav and the tab title ("Claude"). */
  title: z.string().trim().min(1).max(40),
  /** What the page is for, in a sentence (the review page shows it). */
  description: z.string().optional(),
  /** An icon name from the web app's icon set; the app falls back to a generic one it doesn't have. */
  icon: z.string().min(1).optional(),
  nav: SystemPageNav.default('main'),
  access: SystemPageAccess.default('everyone'),
  /** The component in the client build's `client({ pages })` that draws it. */
  component: z.string().min(1),
});
export type SystemPageDecl = z.infer<typeof SystemPageDecl>;
/** A page as an author writes it: `nav` and `access` may be left out. */
export type SystemPageInput = z.input<typeof SystemPageDecl>;

/** The problems with a contract's pages: segments must be unique. Empty when they fit. */
export function systemPageProblems(pages: readonly SystemPageDecl[]): string[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => {
    if (seen.has(page.segment)) { return [`page ${page.segment} is declared twice`]; }
    seen.add(page.segment);
    return [];
  });
}

/** A contract's pages (`Manifest.pages`), checked by `systemPageProblems`, so a hand-written manifest can't repeat a segment either. */
export const SystemPages = z.array(SystemPageDecl).superRefine((pages, ctx) => {
  for (const message of systemPageProblems(pages)) { ctx.addIssue({ code: 'custom', message }); }
});

/** A page as the hub lists it for a person: its system, and the client build that draws it. */
export const SystemPageView = SystemPageDecl.extend({
  system: SystemName,
  /** Where the hub serves the system's client build, and its hash (the build is loaded once per hash). */
  client: z.object({ url: z.string().min(1), hash: z.string().min(1) }),
});
export type SystemPageView = z.infer<typeof SystemPageView>;

/** The path of a system page (`/s/claude/sessions`), with the parts under it (`/s/claude/session/main/abc`). */
export function systemPagePath(system: SystemName | string, segment: string, path: readonly string[] = []): string {
  return ['', 's', system, segment, ...path].map(encodeURIComponent).join('/');
}
