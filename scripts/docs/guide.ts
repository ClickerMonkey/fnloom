/**
 * Builds the authoring guide from a config: extracts the API, reads the prose and repository files, and composes them
 * (`compose.ts`). `isCurrent` says whether a written guide is current. The CLI (`authoring.ts`) passes the real config;
 * tests pass one over a fixture package.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { composeGuide, fence, pruneReached, type Topic } from './compose.ts';
import { extractApi, type ApiModel, type EntryPoint, type ExternalModule } from './extract.ts';

/** What the guide is made from. */
export interface GuideConfig {
  /** The repository root: include paths and printed file paths are relative to it. */
  readonly root: string;
  readonly title: string;
  readonly intro: string;
  readonly entries: readonly EntryPoint[];
  readonly external?: readonly ExternalModule[];
  /** Whether types declared in a file are documented when an export refers to them. */
  readonly reach: (file: string) => boolean;
  readonly reachDepth: number;
  readonly outline: readonly Topic[];
  /** The folder of the prose files (`<topic id>.md`). */
  readonly proseDir: string;
  /** Generated blocks by name, made from the extracted API. */
  readonly generators: (api: ApiModel) => Readonly<Record<string, () => string>>;
}

/** A file's text with Unix line ends, or undefined when it doesn't exist. */
export function readText(path: string): string | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) { return undefined; }
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/** Every file under a folder, relative to it with forward slashes, sorted; folders named in `skip` are left out. */
export function filesUnder(folder: string, skip: readonly string[] = ['node_modules', 'dist']): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!skip.includes(name)) { walk(path); }
      } else {
        out.push(relative(folder, path).replaceAll('\\', '/'));
      }
    }
  };
  walk(folder);
  return out;
}

/** Every file of a folder as a heading and a fenced block, for showing a whole system verbatim. */
export function folderListing(root: string, folder: string): string {
  const base = join(root, folder);
  return filesUnder(base).map((file) => {
    const text = readText(join(base, file)) ?? '';
    const language = /\.([a-z]+)$/i.exec(file)?.[1] ?? 'text';
    return `#### \`${folder}/${file}\`\n\n${fence(text, language)}`;
  }).join('\n\n');
}

/** Build the guide's text. Throws `GuideProblems` when the outline, prose or directives are wrong. */
export function buildGuide(config: GuideConfig): string {
  const api = pruneReached(extractApi({
    root: config.root,
    entries: config.entries,
    ...(config.external === undefined ? {} : { external: config.external }),
    reach: config.reach,
    reachDepth: config.reachDepth,
  }), config.outline);
  return composeGuide({
    title: config.title,
    intro: config.intro,
    outline: config.outline,
    api,
    prose: (id) => readText(join(config.proseDir, `${id}.md`)),
    file: (path) => readText(join(config.root, path)),
    generators: config.generators(api),
  });
}

/** Whether the guide at `path` is `expected` (line ends ignored, so a checkout with CRLF still passes). */
export function isCurrent(path: string, expected: string): boolean {
  return readText(path) === expected;
}
