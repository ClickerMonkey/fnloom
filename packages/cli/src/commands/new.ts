/**
 * `harness system new <name> [--dir <parent>] [--from <template>]`: copy the template system (placeholders and
 * comments, no example code) into `<parent>/<name>` and give it the name: `'template'` and paths become the name,
 * identifiers become its camel and Pascal case (`templateEnv` → `notesDbEnv`, `TemplateConfig` → `NotesDbConfig`).
 */
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SystemName } from '@harness/core';
import { z } from 'zod';
import { command } from '../command.ts';
import { NOT_SOURCE } from '../folder.ts';

/** Where the template system is in this repository. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../../../../systems/template', import.meta.url));
/** The name the template is written with. */
const TEMPLATE = 'template';

/** A system name in camel and Pascal case: `notes-db` → `notesDb`, `NotesDb`. */
export function cases(name: SystemName): { camel: string; pascal: string } {
  const camel = name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
  return { camel, pascal: camel.charAt(0).toUpperCase() + camel.slice(1) };
}

/**
 * Put a system's name into a template file: the name where the template's name is a string, a path or part of a
 * dashed name; its camel case for identifiers and prose (`template`, `templateEnv`); its Pascal case for type names.
 */
export function rename(text: string, name: SystemName): string {
  const { camel, pascal } = cases(name);
  return text
    .replace(/(?<=['"/-]|^# )template\b|\btemplate(?=-)/gm, name)
    .replace(/\btemplate(?=[A-Z]|\b)/g, camel)
    .replace(/\bTemplate(?=[A-Z]|\b)/g, pascal);
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
      await io.files.write(join(target, path), TEXT.test(path) ? rename(new TextDecoder().decode(bytes), name) : bytes);
    }
    io.out.line(`made ${relative(io.cwd, target) || target} (${sources.length} files) from ${relative(io.cwd, from) || from}`);
    io.out.line('next: fill in each TODO, add the folder to the root package.json workspaces and tsconfig.json references, run npm install,');
    io.out.line(`then: harness system build ${relative(io.cwd, target)}`);
    return 0;
  },
});
