/**
 * The mock hub's build 6 samples: a system fs hosts (installed from the chat), and fs's files for the explorer, read
 * live (a small project folder, its text files' contents made up from their names).
 */
import { fileURLToPath } from 'node:url';
import { ApprovalPreview, ContextRecord, Json, HostedBy, ResourceRoot, ResourceStat, SystemParts, type ContextDecl, type Page, type ResourceRead } from '@harness/core';

/** Where the hosted sample system runs. */
export const HOSTED_RANDOM = HostedBy.parse({ host: { system: 'fs', instance: 'main' }, path: 'systems/random', bundleHash: 'a3f1'.repeat(16), approval: 'apr_random_install' });

/**
 * What fs's `install_system` card asks for an update of the hosted sample, in the order fs writes it: what it adds,
 * the diff from the running version, the scan, then the scan's lines of concern as code (the hashes are the subject's).
 */
export const INSTALL_PREVIEW = ApprovalPreview.parse({
  title: 'Update random 0.1.0 → 0.2.0 on fs/main',
  irreversible: false,
  parts: [
    { type: 'text', text: ['Dice, coins and random picks. Built from `systems/random`.', '', 'Fns it keeps:', '- random/roll (read; tags: dice)', '', 'Also adds:', '- type random/Roll'].join('\n') },
    { type: 'text', text: ['Changes from the running version:', '- adds random/flip (read; tags: coins)'].join('\n') },
    { type: 'text', text: ['Scan (a report, not a guarantee):', '- imports node:crypto', '- reads no environment variables', '- no network access'].join('\n') },
    { type: 'code', language: 'js', title: 'server/main.ts:12', code: 'const seed = randomBytes(8).readBigUInt64LE();' },
  ],
  subject: {
    kind: 'system-install', system: 'random', instance: 'main', version: '0.2.0', manifestHash: '5c09'.repeat(16), bundleHash: 'b7e2'.repeat(16), sourceHash: '91d4'.repeat(16),
    host: { system: 'fs', instance: 'main' }, replaces: { version: '0.1.0', manifestHash: '33aa'.repeat(16) },
  },
});

/** What `install_system` answered for the first install of the hosted sample. */
export const INSTALL_RESULT = Json.parse({ system: 'random', instance: 'main', version: '0.1.0', status: 'connected', fns: ['random/roll'], folder: '/home/ada/projects/systems/random' });

/** fs's client build, which draws the install card (served by the mock hub when it has been built). */
export const FS_CLIENT = fileURLToPath(new URL('../../../systems/fs/dist/client/index.js', import.meta.url));
/** Where the mock hub serves it (under `/api`, which the web app's server sends to the hub). */
export const MOCK_CLIENTS = '/mock-clients/';

const ROOT = ResourceRoot.parse({ uri: 'file:///home/ada/projects', name: 'projects', description: 'Ada’s projects', index: 'none', ignore: [], watch: false });
const DAY = 86_400_000;

/** One entry of the sample tree. */
function entry(path: string, size?: number): ResourceStat {
  const uri = `${ROOT.uri}/${path}`;
  return ResourceStat.parse({
    uri, name: path.split('/').at(-1), type: size === undefined ? 'folder' : 'file', version: '1',
    ...(size === undefined ? {} : { size, modifiedAt: Date.UTC(2026, 10, 10) - size * 1_000, format: path.endsWith('.ts') ? 'typescript' : path.endsWith('.md') ? 'markdown' : 'json' }),
  });
}

const TREE: Readonly<Record<string, readonly ResourceStat[]>> = {
  [ROOT.uri]: [entry('random'), entry('notes'), entry('README.md', 1_840)],
  [`${ROOT.uri}/random`]: [entry('random/server'), entry('random/system.json', 412), entry('random/package.json', 655), entry('random/README.md', 1_204)],
  [`${ROOT.uri}/random/server`]: [entry('random/server/main.ts', 2_310), entry('random/server/roll.ts', 980)],
  [`${ROOT.uri}/notes`]: [entry('notes/2026-11-10.md', 3_020), entry('notes/ideas.md', 5_400)],
};

/** fs's files, read live by the explorer. */
export class MockExplorer {
  roots(): ResourceRoot[] {
    return [ROOT];
  }

  list(uri: string): Page<ResourceStat> {
    return { items: [...(TREE[uri] ?? [])] };
  }

  read(uri: string): ResourceRead {
    const found = Object.values(TREE).flat().find((e) => e.uri === uri) ?? entry(uri.slice(ROOT.uri.length + 1), 0);
    const text = found.format === 'typescript'
      ? `/** ${found.name}: part of the random system. */\nimport { system } from '@harness/sdk';\n\nexport function roll(sides = 6): number {\n  return 1 + Math.floor(Math.random() * sides);\n}\n`
      : `# ${found.name}\n\nWritten ${new Date((found.modifiedAt ?? 0) - DAY).toDateString()}.\n`;
    return { stat: found, text: { inline: text } };
  }
}

/**
 * fs's authoring guide as its `context/` folder builds it: a shallow index item offering choices, and the items it
 * points at, each with a title (shown) and a key (its name inside fs, never shown to people).
 */
export function contextFolderSamples(at: number): ContextRecord[] {
  const item = (key: string, title: string, description: string, extra: Partial<ContextDecl> = {}): ContextRecord => ContextRecord.parse({
    name: `fs/${key}`, system: 'fs', updatedAt: at, stale: false, mentions: { context: [], fns: [] }, tokens: { full: 640, summary: 40 },
    decl: { name: key, title, description, content: `# ${title}\n\n${description}\n\nRead the parts this work needs, one at a time; each brings the fns it is about.`, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: ['authoring'], ...extra },
  });
  return [
    item('authoring.index', 'Writing a system', 'Where to start when a person wants a new system: pick the part they need next.', {
      choices: [
        { to: 'fs/authoring.fns', when: 'The person wants the system to do something' },
        { to: 'fs/authoring.kinds', when: 'The person wants a new kind of thing (a table, a form)' },
      ],
    }),
    item('authoring.fns', 'Fns', 'How a fn is declared: its input, output, instructions and examples.', { fns: ['fs/write', 'fs/read'], imports: ['fs/authoring.index'] }),
    item('authoring.kinds', 'Kinds', 'How a kind is declared and how its estimate is worked out.', { visible: 'llm' }),
  ];
}

/** What fs added beyond its fns, context and types, as `systemParts` lists it: a kind, a `/command`, a component and examples. */
export function systemPartsOf(system: string): SystemParts {
  if (system !== 'fs') { return { parts: [], more: {} }; }
  return SystemParts.parse({
    parts: [
      { section: 'kinds', name: 'fs/file', about: 'A file in one of its folders, opened by its path.', origin: 'contract', version: '3be0'.repeat(16), decl: { name: 'file', description: 'A file in one of its folders, opened by its path.' } },
      { section: 'kinds', name: 'fs/folder', about: 'A folder, listed by its path.', origin: 'contract', version: '71c4'.repeat(16), decl: { name: 'folder', description: 'A folder, listed by its path.' } },
      { section: 'commands', name: '/authoring', about: 'How to write a system for the hub.', origin: 'contract', version: '0d9e'.repeat(16), visibility: 'user', owner: 'fs/authoring.index', decl: { name: 'authoring', description: 'How to write a system for the hub.' } },
      { section: 'components', name: 'viewers: Markdown', about: 'Shows markdown files as a page.', origin: 'contract', version: 'e5a2'.repeat(16), decl: { registry: 'viewers', label: 'Markdown', description: 'Shows markdown files as a page.' } },
      { section: 'examples', name: 'fs/read_file #1', about: 'Read the readme at the root of the work folder.', origin: 'contract', version: '9f17'.repeat(16), owner: 'fs/read_file', decl: { fn: 'fs/read_file', text: 'Read the readme at the root of the work folder.', args: { path: 'README.md' } } },
      { section: 'examples', name: 'fs/bash (build)', about: 'Run the build in the work folder.', origin: 'runtime', version: '28bd'.repeat(16), owner: 'fs/bash', decl: { fn: 'fs/bash', text: 'Run the build in the work folder.', args: { command: 'npm run build' } } },
    ],
    more: {},
  });
}
