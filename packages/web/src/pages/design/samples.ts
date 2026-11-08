/**
 * The design gallery's samples for the gin editors and the resource viewers: a type with every kind of field, a
 * value of it, an expression over it, and a resource of each common type drawn without a hub. Made with the SDK's
 * `g` (gin's registry) so they are real gin definitions.
 */
import type { ExprDef } from '@aeye/gin';
import type { GinTypeDef, Json } from '@harness/core';
import { g } from '@harness/sdk';
import type { Table } from '../../resources/logic/tables.ts';

/** A type with every kind of field the editors draw. */
export const SAMPLE_TYPE: GinTypeDef = g.obj({
  path: g.field(g.text({ minLength: 1, maxLength: 200 }), { docs: 'Where the file is, from a root.' }),
  lines: g.field(g.optional(g.num({ min: 1, whole: true })), { docs: 'How many lines to read.' }),
  follow: g.bool(),
  mode: g.enum(['text', 'bytes', 'outline']),
  since: g.optional(g.timestamp()),
  wait: g.duration(),
  tint: g.color(),
  tags: g.list(g.text(), { maxLength: 5 }),
  weights: g.map(g.text(), g.num()),
  span: g.tuple([g.num(), g.num()]),
  target: g.or([g.text(), g.obj({ line: g.num({ whole: true }) })]),
  owner: g.nullable(g.obj({ name: g.text(), email: g.text() })),
}).toJSON();

/** A value of `SAMPLE_TYPE`. */
export const SAMPLE_VALUE: Json = {
  path: 'docs/harness.md', lines: 40, follow: true, mode: 'outline', since: '2026-11-07T09:30:00.000Z', wait: 2_500, tint: 0x3b82f6,
  tags: ['design', 'gin'], weights: [{ key: 'docs', value: 2 }, { key: 'code', value: 1 }], span: [10, 24], target: { line: 12 }, owner: null,
};

/** The variables the sample expression reads. */
export const SAMPLE_SCOPE: Readonly<Record<string, GinTypeDef>> = { name: g.text().toJSON(), count: g.num().toJSON() };

/** An expression: an if over a call, a template and a value. */
export const SAMPLE_EXPR: ExprDef = {
  kind: 'if',
  ifs: [{
    condition: { kind: 'get', path: [{ prop: 'count' }, { prop: 'gt' }, { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } }] },
    body: { kind: 'template', template: 'Many for {name}' },
  }],
  else: { kind: 'new', type: { name: 'text' }, value: 'A few' },
};

/** Code to highlight. */
export const SAMPLE_CODE = `import { system, g, fn } from '@harness/sdk';

/** A notes system with one fn. */
export const notes = system('notes').with({
  fns: {
    add: fn({ description: 'Add a note.', args: g.obj({ text: g.text() }), returns: g.text() }),
  },
});
`;

/** Markdown with a diagram and math. */
export const SAMPLE_MARKDOWN = `## How a turn runs

The hub plans the prompt within the model's window, $B = W - O - M$, then calls it.

\`\`\`mermaid
graph LR
  Message --> Planner --> Model --> Runs
\`\`\`

$$\\sum_{i=1}^{n} w_i \\cdot \\frac{s_i}{\\sqrt{t_i}}$$
`;

/** A two-sheet workbook's tables. */
export const SAMPLE_TABLES: readonly Table[] = [
  { name: 'People', sheetName: 'People', headers: ['name', 'age', 'joined'], rows: [['Ada', '36', '2024-01-04'], ['Grace', '45', '2023-06-12'], ['Alan', '41', '2025-02-20'], ['Katherine', '52', '2022-09-01']] },
  { name: 'Places', headers: ['city', 'people'], rows: [['London', '9000000'], ['Arlington', '238000']] },
];

/** JSON to browse. */
export const SAMPLE_JSON = JSON.stringify({ name: 'harness', private: true, workspaces: ['packages/core', 'packages/sdk', 'packages/hub', 'packages/web'], engines: { node: '>=22.18' }, scripts: { dev: 'tsx scripts/dev.ts', test: 'vitest run' } }, null, 2);

/** A pdf's pages. */
export const SAMPLE_PAGES: readonly string[] = ['Harness\n\nA hub and its systems.', 'Systems connect over WebSocket and add fns, types and resources.', 'The hub owns every model call.'];

/** An html page drawn in the sandbox. */
export const SAMPLE_HTML = '<!doctype html><html><body style="font-family: system-ui; padding: 16px"><h1>Release notes</h1><p>The <b>fs</b> system can watch folders.</p><script>document.body.innerHTML = "scripts ran"</script></body></html>';

/** An SVG image, as a data URL. */
export const SAMPLE_SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" rx="16" fill="#3b82f6"/><circle cx="80" cy="80" r="40" fill="#fff" opacity=".85"/><rect x="132" y="48" width="72" height="64" rx="10" fill="#fff" opacity=".6"/></svg>')}`;

/** A transcript with times. */
export const SAMPLE_TRANSCRIPT = '[0:00] Welcome to the harness walkthrough.\n[0:04] First, pair a system.\n[0:09] Then ask the chat to read a file.';
