/**
 * The `fs/system-authoring` context (`/new-system`): how to write a harness system, so the chat agent can make one with
 * fs's own fns. Its text is the SDK's generated guide (`packages/sdk/AUTHORING.md`, shipped with `@harness/sdk`),
 * followed by where the template system is and the command that copies it. The guide is read each time the context
 * is loaded, so a regenerated guide is current without a restart.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The import specifier of the guide in the SDK package. */
export const AUTHORING_SPECIFIER = '@harness/sdk/AUTHORING.md';

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

/** What follows the guide: where the template is and how to start from it. */
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

/** The context's text: the guide, then the template note. */
export async function authoringText(source: AuthoringSource, signal?: AbortSignal): Promise<string> {
  const guide = await source.guide(signal);
  return `${guide.trimEnd()}\n\n${templateNote(source.template())}\n`;
}
