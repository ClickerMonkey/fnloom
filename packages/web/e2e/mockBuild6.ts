/**
 * The mock hub's build 6 samples: a system fs hosts (installed from the chat), and fs's files for the explorer, read
 * live (a small project folder, its text files' contents made up from their names).
 */
import { ContextRecord, HostedBy, ResourceRoot, ResourceStat, type ContextDecl, type Page, type ResourceRead } from '@harness/core';

/** Where the hosted sample system runs. */
export const HOSTED_RANDOM = HostedBy.parse({ host: { system: 'fs', instance: 'main' }, path: 'systems/random', bundleHash: 'a3f1'.repeat(16), approval: 'apr_random_install' });

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
    decl: { name: key, title, description, content: `# ${title}\n\n${description}`, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: ['authoring'], ...extra },
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
