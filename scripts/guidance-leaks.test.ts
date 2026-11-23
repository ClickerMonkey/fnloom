/**
 * Guidance stays general purpose: no text a model reads (the chat prompt, the hub's fns and context items, every
 * system's contract and authoring prompts, the authoring docs, the design doc and the diagnostician's ground truth)
 * names a subject of the scenario test cases (scripts/scenarios/cases.ts, docs/plans/scenarios-2026-11-21.md) or their
 * data. Phil, 2026-11-23: "I want to be careful to not update any prompts, examples, instructions, etc that talk
 * explicitly about any of the use cases. Like no llm guidance on groceries as an example because I don't want false
 * positives and to pollute that stuff with these test cases. This system is meant to be general purpose."
 *
 * A guide that needs an example uses a neutral one (notes, tasks, projects, orders, tickets) or says it in general
 * terms ("entries of any kind: amounts, dates, notes").
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** Words and phrases from the scenario cases' subjects and data, whole words, any case. */
const SCENARIO_WORDS: readonly string[] = [
  'grocery', 'groceries', 'receipts?', 'chores?', 'chore chart', 'reading minutes?', 'reading list', 'books I\'ve read',
  'furnace', 'home maintenance', 'birthday', 'birthday party', 'dinners?', 'picky', 'running plan', 'this weekend',
  'airport', 'heat pumps?', 'barking', 'recipes?', 'shopping list', 'pantry', 'school letter', 'insurance',
  'times tables?', 'where to eat', 'cheapest gas', 'gas prices?', 'bank statements?', 'dentist', 'band tour',
  'peanuts?', 'allerg(?:y|ies|ic)', 'vacations?', 'beach', 'shoe sizes?', 'pizza', 'weather', 'forecasts?', 'rain',
  'snacks?', 'mortgage', 'netflix', 'spouse', 'wife', 'husband', 'daughter', 'my son', 'kids?', 'dinosaurs?',
  'kroger', 'aldi', 'columbus', 'ohio', 'clintonville', 'alex parker', 'sara', 'emma', 'leo', 'linda',
  'expenses?', 'subscriptions? (?:to cancel|I pay)', 'diet',
];

const PATTERN = new RegExp(`\\b(?:${SCENARIO_WORDS.join('|')})\\b`, 'i');

/** Every file under a folder (or the file itself) whose name passes the test. */
function files(path: string, keep: (name: string) => boolean): string[] {
  const full = join(root, path);
  if (!existsSync(full)) { return []; }
  if (!statSync(full).isDirectory()) { return [full]; }
  return readdirSync(full, { recursive: true, encoding: 'utf8' })
    .map((name) => join(full, name))
    .filter((file) => !file.includes('node_modules') && statSync(file).isFile() && keep(file));
}

const source = (file: string): boolean => /\.(ts|md)$/.test(file) && !/\.test\.ts$/.test(file);
const systems = readdirSync(join(root, 'systems'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

/** The text a model reads, by file: prompts, descriptions, instructions, examples, guides and the docs they come from. */
const MODEL_FACING: readonly string[] = [
  ...files('packages/sdk/src/chat-prompt.ts', source),
  ...files('packages/sdk/src/hub.ts', source),
  ...files('packages/sdk/src/ctx.ts', source),
  ...files('packages/core/src/fn-facts.ts', source),
  ...files('packages/hub/src/chat/suggestions.ts', source),
  ...files('packages/hub/context', source),
  ...systems.flatMap((name) => [
    ...files(`systems/${name}/shared`, source),
    ...files(`systems/${name}/context`, source),
    ...files(`systems/${name}/server`, (file) => source(file) && /author/.test(file)),
  ]),
  ...files('scripts/docs/prose', source),
  ...files('scripts/docs/example', source),
  ...files('scripts/scenarios/mechanisms.md', source),
  ...files('docs/harness.md', source),
];

describe('guidance stays general purpose', () => {
  it('reads every place model-facing text lives', () => {
    expect(MODEL_FACING.length).toBeGreaterThan(50);
    for (const must of ['packages/sdk/src/chat-prompt.ts', 'packages/hub/context/saved_fns.md', 'systems/database/shared/index.ts', 'systems/input/server/authoring.ts', 'docs/harness.md']) {
      expect(MODEL_FACING.map((file) => relative(root, file).replaceAll('\\', '/'))).toContain(must);
    }
  });

  it('names no scenario case\'s subject or data in any of it', () => {
    const found: string[] = [];
    for (const file of MODEL_FACING) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const hit = PATTERN.exec(line);
        if (hit !== null) { found.push(`${relative(root, file).replaceAll('\\', '/')}:${i + 1}: "${hit[0]}" in ${line.trim().slice(0, 140)}`); }
      });
    }
    expect(found).toEqual([]);
  });
});
