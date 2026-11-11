/**
 * `harness system new <name> [--dir <parent>] [--from <template>]`: copy the template system (placeholders and
 * comments, no example code) into `<parent>/<name>` and give it the name: `'template'` and paths become the name,
 * identifiers become its camel and Pascal case (`templateEnv` → `notesDbEnv`, `TemplateConfig` → `NotesDbConfig`).
 * Relative paths in `tsconfig.json` and `package.json` that lead out of the template (the base config, the project
 * references, the build info, `file:` packages) are rewritten to reach the same places from the new folder, so a
 * system made anywhere with `--dir` builds as one made under `systems/`.
 */
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemName } from '@harness/core';
import { z } from 'zod';
import { command } from '../command.ts';
import { NOT_SOURCE } from '@harness/build';

/** Where the template system is in this repository. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../../../../systems/template', import.meta.url));
/** The name the template is written with. */
const TEMPLATE = 'template';

/** A system name in camel, Pascal and constant case: `notes-db` → `notesDb`, `NotesDb`, `NOTES_DB`. */
export function cases(name: SystemName): { camel: string; pascal: string; constant: string } {
  const camel = name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
  return { camel, pascal: camel.charAt(0).toUpperCase() + camel.slice(1), constant: name.replace(/-/g, '_').toUpperCase() };
}

/**
 * Put a system's name into a template file: the name where the template's name is a string, a path or part of a
 * dashed name; its camel case for identifiers and prose (`template`, `templateEnv`); its Pascal case for type names;
 * its constant case for env names and constants (`TEMPLATE_TIMEOUT`).
 */
export function rename(text: string, name: SystemName): string {
  const { camel, pascal, constant } = cases(name);
  return text
    .replace(/(?<=['"/-]|^# )template\b|\btemplate(?=-)/gm, name)
    .replace(/\btemplate(?=[A-Z]|\b)/g, camel)
    .replace(/\bTemplate(?=[A-Z]|\b)/g, pascal)
    .replace(/\bTEMPLATE(?=_|\b)/g, constant);
}

/** A relative path that leads out of `from`, made to reach the same place from `to`; any other value as it is. */
export function rebased(value: string, from: string, to: string): string {
  if (value !== '..' && !value.startsWith('../')) { return value; }
  return relative(to, resolve(from, value)).split(sep).join('/');
}

/** The parts of a `tsconfig.json` that hold paths; everything else is kept as it is. */
const TsconfigPaths = z.looseObject({
  extends: z.string().optional(),
  compilerOptions: z.looseObject({ outDir: z.string().optional(), tsBuildInfoFile: z.string().optional() }).optional(),
  references: z.array(z.looseObject({ path: z.string() })).optional(),
});

/** The parts of a `package.json` that hold paths: `file:` dependencies. */
const PackagePaths = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/** An object with the named string fields passed through `move` (those it has). */
function moved<T extends Record<string, unknown>>(object: T, keys: readonly (keyof T & string)[], move: (value: string) => string): T {
  const changes = Object.fromEntries(keys.flatMap((key) => { const value = object[key]; return typeof value === 'string' ? [[key, move(value)]] : []; }));
  return { ...object, ...changes };
}

/** `file:` dependencies passed through `move`; other versions as they are. */
function movedDeps(deps: Readonly<Record<string, string>> | undefined, move: (value: string) => string): Record<string, string> | undefined {
  if (deps === undefined) { return undefined; }
  return Object.fromEntries(Object.entries(deps).map(([dep, version]) => [dep, version.startsWith('file:') ? `file:${move(version.slice('file:'.length))}` : version]));
}

/** JSON as the repository writes it. */
const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A copied file's text with its outward paths rebased from the template folder to the new one (`tsconfig.json` and
 * `package.json` at any depth); other files as they are.
 */
export function relocate(path: string, text: string, from: string, to: string): string {
  const move = (value: string): string => rebased(value, dirname(join(from, path)), dirname(join(to, path)));
  const file = basename(path);
  if (file === 'tsconfig.json') {
    const config = TsconfigPaths.parse(JSON.parse(text));
    return jsonText({
      ...moved(config, ['extends'], move),
      ...(config.compilerOptions === undefined ? {} : { compilerOptions: moved(config.compilerOptions, ['outDir', 'tsBuildInfoFile'], move) }),
      ...(config.references === undefined ? {} : { references: config.references.map((reference) => moved(reference, ['path'], move)) }),
    });
  }
  if (file === 'package.json') {
    const pkg = PackagePaths.parse(JSON.parse(text));
    const dependencies = movedDeps(pkg.dependencies, move);
    const devDependencies = movedDeps(pkg.devDependencies, move);
    return jsonText({ ...pkg, ...(dependencies === undefined ? {} : { dependencies }), ...(devDependencies === undefined ? {} : { devDependencies }) });
  }
  return text;
}

/** Files read as text and renamed; anything else is copied as it is. */
const TEXT = /\.(?:ts|vue|json|md|txt|css|html|js|mjs|cjs)$/;

export const newCommand = command({
  path: ['system', 'new'],
  summary: 'Make a system folder from the template, with its name filled in.',
  usage: '<name> [--dir <parent folder>] [--from <template folder>]',
  args: z.object({
    positionals: z.tuple([SystemName]),
    values: z.object({ dir: z.string().default('systems'), from: z.string().optional() }),
  }),
  async run({ positionals: [name], values }, io) {
    if (name === TEMPLATE) { io.out.warn('pick a name of your own: "template" is the template'); return 1; }
    const from = values.from === undefined ? TEMPLATE_DIR : resolve(io.cwd, values.from);
    const target = resolve(io.cwd, values.dir, name);
    if (await io.files.stat(target) !== undefined) { io.out.warn(`${target} already exists`); return 1; }
    if (await io.files.stat(join(from, 'system.json')) === undefined) { io.out.warn(`${from} is not a system folder (no system.json)`); return 1; }
    const sources = await io.files.walk(from, NOT_SOURCE);
    for (const source of sources) {
      const path = relative(from, source);
      const bytes = await io.files.read(source);
      await io.files.write(join(target, path), TEXT.test(path) ? relocate(path, rename(new TextDecoder().decode(bytes), name), from, target) : bytes);
    }
    io.out.line(`made ${relative(io.cwd, target) || target} (${sources.length} files) from ${relative(io.cwd, from) || from}`);
    io.out.line('next: fill in each TODO, add the folder to the root package.json workspaces and tsconfig.json references, run npm install,');
    io.out.line(`then: harness system build ${relative(io.cwd, target)}`);
    return 0;
  },
});
