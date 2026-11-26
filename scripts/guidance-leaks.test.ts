/**
 * Guidance stays general purpose: no text a model reads (the chat prompt, the hub's fns and context items, every
 * system's contract and authoring prompts, the authoring docs, the design doc and the diagnostician's ground truth)
 * names a subject of the scenario test cases (scripts/scenarios/cases*.ts, docs/plans/scenarios-*.md) or their
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
  // trips and travel as a subject; not a "round trip" or data that "travels together/with/as/back"
  '(?<!round[- ])trips?', 'travel(?:l?ers?|l?ing)?(?! together| with| as | back|,)',
  'airport', 'heat pumps?', 'barking', 'recipes?', 'shopping list', 'pantry', 'school letter', 'insurance',
  'times tables?', 'where to eat', 'cheapest gas', 'gas prices?', 'bank statements?', 'dentist', 'band tour',
  'peanuts?', 'allerg(?:y|ies|ic)', 'vacations?', 'beach', 'shoe sizes?', 'pizza', 'weather', 'forecasts?', 'rain',
  'snacks?', 'mortgage', 'netflix', 'spouse', 'wife', 'husband', 'daughter', 'my son', 'kids?', 'dinosaurs?',
  'kroger', 'aldi', 'columbus', 'ohio', 'clintonville', 'alex parker', 'sara', 'emma', 'leo', 'linda',
  'expenses?', 'subscriptions? (?:to cancel|I pay)', 'diet',
  // added in iteration 4 (2026-11-25): more of the cases' subjects and data
  '(?<!third[- ])part(?:y|ies)', 'class party', 'neighbou?r', 'dogs?', 'favou?rite band', 'mom', 'thanksgiving', 'turkey',
  'tacos?', 'pasta', 'mushrooms?', 'spicy', 'gym', 'peloton', '(?<![0-9])5k', 'jog(?:ging)?', 'fitness', 'shoes?', 'heating', 'dentist appointment',
  'pwned', 'breach(?:es)?', 'photos? of the', 'classroom',
  // the second set's subjects and data (cases 41-80, scripts/scenarios/cases-2.ts, docs/plans/scenarios-2-2026-11-26.md)
  'fill(?:[- ])?ups?', 'gallons?', 'library books?', 'cookie swap', 'dozen cookies', 'baking', 'surprise', 'chicago', 'hardware store',
  'porch light', 'wood glue', 'picture hooks', 'homework', 'taxes', 'tax documents?', 'electric bills?', 'power company',
  'kwh', 'a shed', 'sheds', 'backyard', 'hoa', 'homeowners association', 'pto', 'bake sale', 'whiteboard', 'holiday cards?', 'address list',
  'scanner', 'dishwasher', 'model number', 'recycling', 'curb', 'cat medicine', 'vet', 'piano', 'winter break', 'biking', 'bike',
  'paint', '8-foot ceilings', 'worthington', 'cilantro', 'mother-in-law', 'coffee', 'lunch(?:es|box(?:es)?)', 'garage sale',
  'hendersons?', 'packing list', 'grandma', 'dayton', 'thank-you notes?', 'rachael?', 'passport', 'doctor\'s note', 'skip school',
  'eating out', 'zoo', 'soccer', 'camping', 'cabin', 'tents?', 'biscuit', 'okafor', 'joan', 'sarasota', 'bosch', 'glen echo',
  // the third set's subjects and data (cases 81-84, scripts/scenarios/cases-3.ts, docs/plans/scenarios-3-2026-11-26.md)
  'blood pressure', 'pulse', 'birds?', 'bird ?feeders?', 'feeders?', 'cardinals?', 'blue jays?', 'woodpeckers?', 'goldfinch(?:es)?',
  'raked? leaves', 'weekend chores?', 'counts? double', 'movie night', 'movies?', 'paddington', 'moana', 'inside out', 'whose turn (?:is it|to pick)',
];

// whole words, also inside a snake_case or dotted name (iteration 4: `database/main.expenses_create` hid behind `\b`)
const PATTERN = new RegExp(`(?<![A-Za-z])(?:${SCENARIO_WORDS.join('|')})(?![A-Za-z])`, 'i');

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
  // the lines the hub adds to messages and results (iteration 4: these were not read before)
  ...files('packages/hub/src/chat/enrich.ts', source),
  ...files('packages/hub/src/chat/announce.ts', source),
  ...files('packages/hub/src/chat/cite-rule.ts', source),
  ...files('packages/hub/src/contextor', source),
  ...files('packages/hub/src/boot/hub-fns.ts', source),
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
