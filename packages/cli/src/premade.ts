/**
 * The premade systems, in one place: which ones `harness start` runs, which ones ship ready to run in the base package
 * and which ones ship as package zips that pull their own dependencies when installed, and which ones come along with
 * another. `harness system available`, `harness system install`, `scripts/start.ts` and the release pack
 * (`scripts/release/pack.ts`) all read this table, so changing the default set is one edit here.
 *
 * - **Lightweight** systems (their third-party dependencies are ones the hub already has, or a few kB more) ship as
 *   their source folder in the base package, so they run with no install step. The `start` ones run with every
 *   `harness start`; the others install from that folder (`harness system install schedule`).
 * - **Heavy** systems (`package: true`) are left out of the base package and its dependencies. The release packs each
 *   with `harness system pack` into `premade/<name>.zip` (its server bundled, the npm packages named in its
 *   `system.json` `server.external` left out), and `harness system install <name>` installs that zip: the hub
 *   `npm install`s those externals into the system's own folder, so puppeteer's Chrome or the Claude Agent SDK lands
 *   only on a machine that asked for that system. In the repository the folder is there and is used instead.
 * - `with`: systems that are installed alongside it when missing (database brings widgets: widgets draws charts and
 *   tables from database queries).
 */

/** How one premade system ships and starts. */
export interface Premade {
  /** When `harness start` runs it: `'always'`, or the settings it needs (it runs once they are all set). */
  readonly start?: 'always' | { readonly when: readonly string[] };
  /** The stack's process name, when it differs from the system's (`calendar` for google-calendar). */
  readonly component?: string;
  /** Shipped as a package zip whose npm dependencies are installed with it, not in the base package. */
  readonly package?: true;
  /** Installed alongside it when not installed yet. */
  readonly with?: readonly string[];
  /** What a person installing it alone should know (shown by `harness system install`). */
  readonly note?: string;
}

/** Every premade system by folder name (the template `harness system new` copies is not one). */
export const PREMADE: Readonly<Record<string, Premade>> = {
  fs: { start: 'always' },
  input: { start: 'always' },
  code: { start: 'always' },
  schedule: { start: 'always' },
  api: { start: 'always' },
  'google-calendar': { start: { when: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] }, component: 'calendar' },
  embedder: { start: { when: ['HARNESS_EMBEDDER_URL'] } },
  ollama: {},
  mcp: {},
  widgets: { note: 'widgets draws charts and tables from database queries: install database too (harness system install database --config <file.json>)' },
  // SQL Server and Postgres drivers, and better-sqlite3 built for the system's own folder
  database: { package: true, with: ['widgets'] },
  // puppeteer and the Chrome it downloads
  web: { package: true, component: 'web-system' },
  // the Claude Agent SDK and the Claude Code it carries
  claude: { package: true },
};

/** The premade systems shipped as package zips (left out of the base package). */
export function packagedSystems(): string[] {
  return Object.entries(PREMADE).filter(([, premade]) => premade.package === true).map(([name]) => name);
}

/** The stack process a premade system runs as (`calendar`, `web-system`, else its own name). */
export function componentOf(name: string): string {
  return PREMADE[name]?.component ?? name;
}

/** The premade system a stack process name means (`calendar` is google-calendar), or the name itself. */
export function systemOfComponent(component: string): string {
  return Object.entries(PREMADE).find(([, premade]) => premade.component === component)?.[0] ?? component;
}

/** The stack processes `harness start` runs, given the environment: the hub and the systems whose settings are set. */
export function startComponents(environment: Readonly<Record<string, string | undefined>>): string[] {
  const started = Object.entries(PREMADE).filter(([, premade]) => premade.start === 'always'
    || (premade.start !== undefined && premade.start.when.every((name) => (environment[name] ?? '') !== '')));
  return ['hub', ...started.map(([name]) => componentOf(name))];
}

/** When `harness start` runs a premade system, in words; undefined when it is installed on demand. */
export function startedWhen(name: string): string | undefined {
  const start = PREMADE[name]?.start;
  if (start === undefined) { return undefined; }
  return start === 'always' ? 'always' : `when ${start.when.join(' and ')} ${start.when.length === 1 ? 'is' : 'are'} set`;
}
