/**
 * The authoring context's start item: `fs/system-authoring` (`/new-system`). The SDK's generated guide
 * (`packages/sdk/AUTHORING.md`, shipped with `@harness/sdk`) is too big for one prompt, so fs serves it from its
 * context folder (`context/authoring/`, written by `npm run docs:authoring`) as a graph: a shallow index
 * (`fs/authoring`), topic groups, one item per part. The start item imports the index, so it always comes with it, and
 * adds what only this machine knows: where the template system is, how to start from it and how to install the result.
 * The whole guide is still offered at once (`authoringText`) for a model with a window big enough to read it.
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

/** Where the template is, how to start from it, and how to install the result. */
export function templateNote(folder: string | undefined): string {
  const where = folder === undefined
    ? 'The template system is `systems/template` in the harness repository (it is not on this machine).'
    : `The template system is at \`${folder}\` (\`systems/template\` in the harness repository).`;
  return [
    '## Making a system here',
    '',
    where,
    'Start a new system with `harness system new <name>`, which copies it to `systems/<name>` and fills in the name. Without',
    'the CLI, copy the folder with fs/bash (`cp -r systems/template systems/<name>`: paths in bash use forward slashes) and',
    'replace the word `template` (the name, `templateEnv`, `TemplateDeps`, …) with the new name in every file. Then write the',
    'contract, the implementation and the tests with fs/write and fs/edit; fs/write makes the folders a file needs, so never',
    '`mkdir` first. Run the system\'s tests with fs/bash (`npx vitest run systems/<name>`) until they pass.',
    '',
    '## Installing it',
    '',
    'Call fs/install_system with the folder (`{ "path": "systems/<name>" }`). It typechecks the folder with its own',
    '`tsconfig.json`, bundles and scans it; when that fails you get `file:line:col` lines to fix with fs/edit, then call it',
    'again. A good build becomes a card for an admin; once approved, it starts on this machine and connects to the hub, and',
    'the answer lists its fns (load them with hub/fns_load to try them). After every change call fs/install_system again;',
    'fs/system_status shows whether it runs, and the end of its output after a crash.',
  ].join('\n');
}

/**
 * The start item's text: the fns it brings, how to walk the guide (its index comes with it), then where the template is
 * and how to install the result.
 */
export function authoringStart(source: AuthoringSource): string {
  return [
    '# Writing a harness system',
    [
      'This brings fs/read, fs/write, fs/edit and fs/bash, already in your tools, and fs/install_system to install the',
      'system once it is written.',
    ].join('\n'),
    [
      'The guide comes with this as its index (`fs/authoring`), which offers its topic groups as choices. Load the group',
      'the work needs with `hub/ctx_load` (`{ "context": ["fs/authoring.topics.begin"] }`), then the parts it offers,',
      'one at a time; each brings the same fns.',
    ].join('\n'),
    templateNote(source.template()),
  ].join('\n\n') + '\n';
}

/** The whole guide followed by the template note, for a model with a window big enough to read it at once. */
export async function authoringText(source: AuthoringSource, signal?: AbortSignal): Promise<string> {
  const guide = await source.guide(signal);
  return `${guide.trimEnd()}\n\n${templateNote(source.template())}\n`;
}
