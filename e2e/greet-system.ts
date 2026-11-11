/**
 * The small system the install suite writes into `systems/greet` and installs from the chat's fs: a contract with one
 * fn (`greet/hello`), and a process that, once connected, adds at runtime a fn (`greet/shout`), a type
 * (`greet/Greeting`), a context entry (`greet/note`, whose text a hub model wrote outside any run with `hubAi`) and a
 * contribution to the database's query visuals. `version` changes the greeting, so a second install has a diff.
 */

/** What the files are made from. */
export interface GreetOptions {
  /** The version in `system.json`. */
  readonly version: string;
  /** The word `hello` greets with. */
  readonly word: string;
  /** A context folder entry, as markdown with its YAML header, when the suite wants one (a broken link fails the build). */
  readonly context?: string;
}

/** The system's files, by path under its folder. */
export function greetFiles(options: GreetOptions): Record<string, string> {
  return {
    'system.json': JSON.stringify({
      format: 1, name: 'greet', version: options.version, description: 'Greets people by name.', protocol: 1,
      server: { entry: 'server/main.ts', external: {} }, instances: 'one',
    }, null, 2),
    'package.json': JSON.stringify({ name: '@harness/system-greet', private: true, version: '0.0.0', type: 'module' }, null, 2),
    'tsconfig.json': JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: '.', outDir: '../../.types/system-greet', tsBuildInfoFile: '../../.types/system-greet.tsbuildinfo', types: ['node'] },
      include: ['shared', 'server'],
      references: [{ path: '../../packages/core' }, { path: '../../packages/sdk' }],
    }, null, 2),
    'shared/index.ts': [
      "import { fn, g, system } from '@harness/sdk';",
      '',
      '/** Greets people by name. */',
      "export const greet = system('greet', { description: 'Greets people by name.' }).with({",
      '  fns: {',
      '    hello: fn({',
      "      description: 'Say hello to someone by name.',",
      "      instructions: 'Call it when the person wants a greeting. Give `name`; it returns the greeting as text.',",
      `      examples: [{ args: { name: 'Ana' }, result: '${options.word}, Ana!' }],`,
      '      args: g.obj({ name: g.text() }),',
      '      returns: g.text(),',
      "      effects: { mode: 'read', free: true },",
      '    }),',
      '  },',
      '});',
      '',
    ].join('\n'),
    'server/main.ts': [
      "import { env } from '@ayepi/env';",
      "import { GinTypeDef } from '@harness/core';",
      "import { fn, g } from '@harness/sdk';",
      "import { hubAi, loggedHost, serve, systemFields, systemState } from '@harness/sdk/server';",
      "import { greet } from '../shared/index.ts';",
      '',
      "const settings = env({ ...systemFields() }).add(systemState('greet')).parse();",
      'const { host, log } = loggedHost(greet.name);',
      'const running = await serve(greet, {',
      `  fns: { hello: { async run(args, ctx) { return ctx.done(\`${options.word}, \${args.name}!\`); } } },`,
      '}, {',
      '  hub: settings.HARNESS_HUB,',
      '  state: settings.HARNESS_SYSTEM_STATE,',
      '  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),',
      '}, host);',
      'await running.ready();',
      '',
      '// added while running: a fn, a type, a context entry and a contribution to a registry of another system',
      "await running.add('shout', fn({",
      "  description: 'Say a text loudly, in capitals.',",
      "  instructions: 'Call it when the person wants a text shouted. Give `text`; it returns it in capitals.',",
      "  examples: [{ args: { text: 'hi' }, result: 'HI' }],",
      '  args: g.obj({ text: g.text() }),',
      '  returns: g.text(),',
      "  effects: { mode: 'read', free: true },",
      '}), { async run(args, ctx) { return ctx.done(args.text.toUpperCase()); } });',
      "await running.types([{ name: 'Greeting', description: 'A greeting said to someone.', def: GinTypeDef.parse(g.obj({ to: g.text(), text: g.text() }).toJSON()), display: { label: 'Greeting', title: 'to' }, methods: [] }], []);",
      '',
      '// a hub model, outside any run: the system pays for it from its own budget',
      'let note = "No model answered.";',
      'try {',
      '  const ai = await hubAi(running);',
      "  note = (await ai.chat.get({ messages: [{ role: 'user', content: 'Write one short friendly sentence about saying hello.' }] }, { metadata: { model: 'role/chat' } })).content;",
      '} catch (error) {',
      "  log.warn('greet.ai.failed', { error: error instanceof Error ? error.message : String(error) });",
      '}',
      'await running.patch({',
      "  upsert: { context: [{ name: 'note', title: 'A note on greetings', description: 'A note on saying hello, written by a model when greet started.', content: note, imports: [], fns: ['greet/hello'], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: ['greet'] }] },",
      "  lists: { contributes: [{ registry: 'database/query-visuals', name: 'greeting', label: 'Greeting' }] },",
      '});',
      "log.info('greet.ready', { note });",
      '',
    ].join('\n'),
    ...(options.context === undefined ? {} : { 'context/guide.md': options.context }),
  };
}
