/**
 * The authoring context: how to write a harness system, so the chat agent can make one with fs's own fns. The SDK's
 * generated guide (`packages/sdk/AUTHORING.md`, shipped with `@harness/sdk`) is too big for one prompt, so it is
 * offered in parts: `fs/system-authoring` (`/new-system`) is the start item, with the guide's intro, the list of its
 * parts and their sizes, and where the template system is; each section of the guide is its own context item under it
 * (`fs/authoring-<topic>`, listed in `../shared/authoring.gen.ts`), naming the part after it, so a contextor can pick
 * the parts a budget allows and a model can load the rest by name. The guide is read each time a part is loaded, so a
 * regenerated guide is current without a restart.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AUTHORING_PARTS, type AuthoringPart } from '../shared/authoring.gen.ts';
import { sectionOf } from './sections.ts';

/** The import specifier of the guide in the SDK package. */
export const AUTHORING_SPECIFIER = '@harness/sdk/AUTHORING.md';

/** The heading the guide's table of contents starts with; the intro is everything above it. */
const CONTENTS_HEADING = '## Contents';

/** Where the guide and the template are. An interface so tests use fakes. */
export interface AuthoringSource {
  /** The guide's markdown. */
  guide(signal?: AbortSignal): Promise<string>;
  /** The template system's folder on this machine, if it is there. */
  template(): string | undefined;
}

/** How to find a module's file: `import.meta.resolve`, by default. */
export type Resolve = (specifier: string) => string;

/**
 * The guide shipped with the installed SDK, resolved like any import, and the template beside it in the harness
 * repository (`systems/template`, two folders up from the SDK package) when this checkout has one.
 */
export class PackagedAuthoring implements AuthoringSource {
  readonly #resolve: Resolve;
  readonly #exists: (path: string) => boolean;

  constructor(resolve: Resolve = (specifier) => import.meta.resolve(specifier), exists: (path: string) => boolean = existsSync) {
    this.#resolve = resolve;
    this.#exists = exists;
  }

  guide(signal?: AbortSignal): Promise<string> {
    return readFile(this.#guideUrl(), { encoding: 'utf8', ...(signal === undefined ? {} : { signal }) });
  }

  template(): string | undefined {
    const folder = fileURLToPath(new URL('../../systems/template', this.#guideUrl()));
    return this.#exists(folder) ? folder : undefined;
  }

  #guideUrl(): URL {
    return new URL(this.#resolve(AUTHORING_SPECIFIER));
  }
}

/** The parts in the guide's order. */
const PART_NAMES = Object.keys(AUTHORING_PARTS).filter((name): name is AuthoringPart => Object.hasOwn(AUTHORING_PARTS, name));

/** What the start item and a part's ending read of each part. */
interface PartInfo {
  readonly heading: string;
  readonly title: string;
  readonly tokens: number;
  readonly reference: boolean;
  /** The part a reader goes on to; none after the last of its kind. */
  readonly next?: AuthoringPart;
}

/** A part's facts. */
function infoOf(part: AuthoringPart): PartInfo {
  return AUTHORING_PARTS[part];
}

/** The heading the part after `part` starts with, where its section ends: the next part's in the guide's order. */
function endOf(part: AuthoringPart): string | undefined {
  const after = PART_NAMES[PART_NAMES.indexOf(part) + 1];
  return after === undefined ? undefined : infoOf(after).heading;
}

/** A part as a list line: its context name, title and size. */
function partLine(part: AuthoringPart): string {
  const { title, tokens } = infoOf(part);
  return `- \`fs/${part}\`: ${title} (about ${tokens.toLocaleString('en-US')} tokens)`;
}

/** What follows the parts list: where the template is and how to start from it. */
export function templateNote(folder: string | undefined): string {
  const where = folder === undefined
    ? 'The template system is `systems/template` in the harness repository (it is not on this machine).'
    : `The template system is at \`${folder}\` (\`systems/template\` in the harness repository).`;
  return [
    '## Making a system here',
    '',
    where,
    'Start a new system with `harness system new <name>`, which copies it to `systems/<name>` and fills in the name. Without',
    'the CLI, copy the folder with fs/bash and replace the word `template` (the name, `templateEnv`, `TemplateDeps`, …) with',
    'the new name in every file. Then write the contract, the implementation and the tests with fs/write and fs/edit, add',
    'the folder to the root `tsconfig.json` references, and run `npm run typecheck` and its tests with fs/bash until they pass.',
  ].join('\n');
}

/**
 * The start item's text: the guide's title and intro, its parts with their sizes (the guide's parts first, then the
 * reference parts), how to load one, then where the template is.
 */
export async function authoringStart(source: AuthoringSource, signal?: AbortSignal): Promise<string> {
  const guide = (await source.guide(signal)).replaceAll('\r\n', '\n');
  const contents = guide.indexOf(`\n${CONTENTS_HEADING}\n`);
  const intro = (contents < 0 ? guide : guide.slice(0, contents)).trimEnd();
  const guideParts = PART_NAMES.filter((part) => !infoOf(part).reference);
  const reference = PART_NAMES.filter((part) => infoOf(part).reference);
  return [
    intro,
    '## The parts of this guide',
    [
      'The guide is too long for one prompt, so each of its sections is a context item of its own. Read the ones the work',
      'needs, in this order, loading each by its name (`hub/context_get` with the name); each part names the one after',
      'it. Start with `fs/authoring-start`.',
    ].join('\n'),
    guideParts.map(partLine).join('\n'),
    'Reference parts, to look something up:',
    reference.map(partLine).join('\n'),
    templateNote(source.template()),
  ].join('\n\n') + '\n';
}

/** A part's text: its section of the guide, then the name of the part after it. */
export async function authoringPart(source: AuthoringSource, part: AuthoringPart, signal?: AbortSignal): Promise<string> {
  const guide = await source.guide(signal);
  const { heading, next } = infoOf(part);
  const section = sectionOf(guide, heading, endOf(part));
  if (section === undefined) { throw new Error(`the authoring guide has no section "${heading}": regenerate it with npm run docs:authoring`); }
  const after = next === undefined ? 'This is the last part of its kind.' : `Next: \`fs/${next}\` (${infoOf(next).title}).`;
  return `${section}\n\n${after}\n`;
}

/** The whole guide followed by the template note, for a model with a window big enough to read it at once. */
export async function authoringText(source: AuthoringSource, signal?: AbortSignal): Promise<string> {
  const guide = await source.guide(signal);
  return `${guide.trimEnd()}\n\n${templateNote(source.template())}\n`;
}
