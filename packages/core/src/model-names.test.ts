import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FN_NAME_PATTERN, FnLocalName, FnNameIndex, fnLocalNameProblem, fnOfModelNameByRule, fnOfStoredToolName, isCutModelName, legacyFnOfToolName, ModelFnName, modelFnName,
  modelFnNames, RULE_ONLY_NAMES, sha256Hex, bareNamesIn, cutNamesIn, isFnShaped, slashedName, typeMatches, unresolvedNamesIn, type ModelFnNameRegistry,
} from './model-names.ts';
import { JsonObject, QualifiedName } from './primitives.ts';
import type { GinTypeDef } from './gin.ts';

const fn = (name: string): QualifiedName => QualifiedName.parse(name);
const FN_NAME: GinTypeDef = { name: 'text', options: { pattern: FN_NAME_PATTERN } };
const LONG = fn('database/household_budget.monthly_grocery_spending_by_store_and_category_since_2024');

describe('the model name format', () => {
  it('writes every / and . as __, and reads it back by rule', () => {
    const table: Array<[string, string]> = [
      ['hub/fns_search', 'hub__fns_search'],
      ['hub/ctx_search', 'hub__ctx_search'],
      ['input/get_input', 'input__get_input'],
      ['database/main.expenses_create', 'database__main__expenses_create'],
      ['fs/Entry.reveal', 'fs__Entry__reveal'],
      ['google-calendar/list_events', 'google-calendar__list_events'],
    ];
    for (const [qualified, model] of table) {
      expect(modelFnName(fn(qualified))).toBe(model);
      expect(fnOfModelNameByRule(model)).toBe(qualified);
      expect(ModelFnName.safeParse(model).success).toBe(true);
    }
  });

  it('cuts a name past 64 to 54, drops a trailing _, and ends it with _x and 8 hex of the sha-256', () => {
    const name = modelFnName(LONG);
    expect(name).toBe(`database__household_budget__monthly_grocery_spending_b_x${sha256Hex(LONG).slice(0, 8)}`);
    expect(name).toHaveLength(64);
    expect(isCutModelName(LONG)).toBe(true);
    // a cut name is never read back by rule: only the registry knows it
    expect(fnOfModelNameByRule(name)).toBeUndefined();
    // a cut that would end in `_` drops it before `_x`
    const trailing = fn(`fs/${'a'.repeat(49)}_${'b'.repeat(20)}`);
    expect(modelFnName(trailing)).toMatch(/^fs__a{49}_x[0-9a-f]{8}$/);
    // exactly 64 is not cut
    const exact = fn(`fs/${'a'.repeat(60)}`);
    expect(modelFnName(exact)).toBe(`fs__${'a'.repeat(60)}`);
  });

  it('hashes with sha-256, synchronously', () => {
    for (const text of ['', 'abc', 'hub/fns_search', 'é ünïcode', 'x'.repeat(200)]) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });

  it('keeps a fn local name the model name can carry, and says what is wrong with one it can\'t', () => {
    for (const ok of ['read', 'Entry.reveal', 'main.expenses_create', 'a-b', 'x2', '2fa', 'a_b.c_d']) expect(FnLocalName.safeParse(ok).success).toBe(true);
    for (const bad of ['a__b', '_a', 'a_', 'a._b', 'a_.b', 'a.', '.a', '']) expect(FnLocalName.safeParse(bad).success).toBe(false);
    expect(fnLocalNameProblem('a__b')).toContain('`__`');
    expect(fnLocalNameProblem('a._b')).toContain('starts or ends with `_`');
    expect(fnLocalNameProblem('main.ok')).toBeUndefined();
  });

  it('reads stored tool names for people: the new rule, a cut name looked up, and the legacy spelling', () => {
    expect(fnOfStoredToolName('fs__Entry__reveal')).toBe('fs/Entry.reveal');
    expect(fnOfStoredToolName('fs__Entry--reveal')).toBe('fs/Entry.reveal');
    expect(legacyFnOfToolName('database__main--x')).toBe('database/main.x');
    expect(fnOfStoredToolName('fs/read')).toBe('fs/read');
    expect(fnOfStoredToolName('find')).toBeUndefined();
    expect(fnOfStoredToolName(modelFnName(LONG), (name) => (name === modelFnName(LONG) ? LONG : undefined))).toBe(LONG);
  });
});

describe('the registry', () => {
  it('reads every name back by lookup, dots, methods, saved fns and cut names alike', () => {
    const fns = [fn('fs/read'), fn('fs/Entry.reveal'), fn('database/main.expenses_create'), LONG];
    const index = FnNameIndex.of(fns);
    for (const name of fns) expect(index.fnOf(modelFnName(name))).toBe(name);
    expect(index.isFn('fs/read')).toBe(true);
    expect(index.isFn('fs/guide')).toBe(false);
    expect(index.fnOf('fs__nope')).toBeUndefined();
  });

  it('refuses a second fn whose model name is taken, which only a hash can make', () => {
    const index = FnNameIndex.of([LONG]);
    const twin = fn(`${LONG}_other`);
    expect(modelFnName(twin).slice(0, 54)).toBe(modelFnName(LONG).slice(0, 54));
    expect(index.collision(twin)).toBeUndefined(); // a different hash: no collision
    expect(index.collision(LONG)).toBeUndefined(); // a fn never collides with itself
  });

  it('keeps a gone fn\'s name in its history, so an old call still reads back', () => {
    const index = FnNameIndex.of([fn('database/main.q1'), fn('fs/read')]);
    const entry = index.remove(fn('database/main.q1'), 42);
    expect(entry).toEqual({ model: 'database__main__q1', fn: 'database/main.q1', until: 42 });
    expect(index.isFn('database/main.q1')).toBe(false);
    expect(index.fnOf('database__main__q1')).toBe('database/main.q1');
    const reloaded = FnNameIndex.of([fn('fs/read')], entry === undefined ? [] : [entry]);
    expect(reloaded.fnOf('database__main__q1')).toBe('database/main.q1');
    expect(reloaded.size).toBe(1);
  });
});

describe('the boundary', () => {
  const index = FnNameIndex.of([fn('fs/read'), fn('fs/Entry.reveal'), fn('hub/fns_search'), fn('hub/ctx_load'), fn('hub/load'), LONG]);
  const tools = modelFnNames({ index, mode: { type: 'tools' } });
  const statics = modelFnNames({ index, mode: { type: 'static', tools: { find: { fn: fn('hub/fns_search') }, load: { fn: fn('hub/load'), also: [fn('hub/ctx_load')] } } } });

  it('names fns as the model calls them in each mode, and reads every form back', async () => {
    // a cut name reads back only once it is learned (or given out by this object)
    await tools.learn([modelFnName(LONG)]);
    expect(tools.name(fn('hub/fns_search'))).toBe('hub__fns_search');
    expect(statics.name(fn('hub/fns_search'))).toBe('find');
    expect(statics.name(fn('hub/ctx_load'))).toBe('load');
    expect(statics.name(fn('fs/read'))).toBe('fs__read');
    expect(statics.fn('find')).toBe('hub/fns_search');
    expect(statics.fn('load')).toBe('hub/load');
    expect(tools.fn('fs__Entry__reveal')).toBe('fs/Entry.reveal');
    expect(tools.fn(modelFnName(LONG))).toBe(LONG);
    // a qualified name the model writes anyway is tolerated
    expect(tools.fn('fs/read')).toBe('fs/read');
    expect(tools.fn('nothing')).toBeUndefined();
  });

  it('finds fns in text: refs and known names standing alone, never paths, context keys or types', async () => {
    const text = [
      'Read it with fn:fs/read, or call fs/read.',
      'See context:fs/guide and fs/Entry, then fs/Entry.reveal.',
      'Not file:///repo/fs/read nor docs/fs/read.md nor fs/readme.',
      `Long: ${LONG}`,
    ].join('\n');
    // the registry is asked once, before anything is spelled
    await tools.learn([text]);
    await statics.learn(['Use hub/fns_search then hub/ctx_load.']);
    expect(tools.text(text)).toBe([
      'Read it with fs__read, or call fs__read.',
      'See fs/guide and fs/Entry, then fs__Entry__reveal.',
      'Not file:///repo/fs/read nor docs/fs/read.md nor fs/readme.',
      `Long: ${modelFnName(LONG)}`,
    ].join('\n'));
    expect(statics.text('Use hub/fns_search then hub/ctx_load.')).toBe('Use find then load.');
    // text is idempotent: what it wrote reads the same again
    expect(tools.text(tools.text(text))).toBe(tools.text(text));
    // with no registry only refs are rendered
    expect(modelFnNames({ index: RULE_ONLY_NAMES, mode: { type: 'tools' } }).text('fn:fs/read and fs/read')).toBe('fs__read and fs/read');
  });

  it('spells fn-shaped names no fn holds by the rule (Encode by rule), and keeps context keys, kinds and types', async () => {
    const shaped = FnNameIndex.of([fn('fs/read')], [], {
      systems: ['database', 'input', 'code', 'api', 'hub', 'fs'], reserved: ['database/guide', 'database/query', 'input/form', 'hub/llm', 'fs/Entry'],
    });
    const names = modelFnNames({ index: shaped, mode: { type: 'tools' } });
    const text = [
      'Saved as database/main.overdue_invoices, input/trip_details, code/price_with_tax or api/github.open_issues.',
      'Kinds and keys stay: database/query, input/form, hub/llm, database/guide, database/guide.md, fs/Entry and fs/Entry.size.',
      'A family stays: input/ask_; other systems and paths too: shop/get, docs/fs/read.md. A known fn: fs/read.',
    ].join('\n');
    await names.learn([text]);
    expect(names.text(text)).toBe([
      'Saved as database__main__overdue_invoices, input__trip_details, code__price_with_tax or api__github__open_issues.',
      'Kinds and keys stay: database/query, input/form, hub/llm, database/guide, database/guide.md, fs/Entry and fs/Entry.size.',
      'A family stays: input/ask_; other systems and paths too: shop/get, docs/fs/read.md. A known fn: fs__read.',
    ].join('\n'));
    // an attribute's value is spelled only when it is a known fn (a mention's provider keeps its `/`)
    await names.learn(['<mention provider="fs/files"> <run fn="fs/read">']);
    expect(names.text('<mention provider="fs/files"> <run fn="fs/read">')).toBe('<mention provider="fs/files"> <run fn="fs__read">');
    // the rule's names read back by the rule, like any fn's
    expect(names.fn('database__main__overdue_invoices')).toBe('database/main.overdue_invoices');
    expect(isFnShaped(fn('database/main.x'), new Set(['database']), new Set())).toBe(true);
    expect(isFnShaped(fn('database/Expense'), new Set(['database']), new Set())).toBe(false);
    expect(isFnShaped(fn('database/x'), new Set(), new Set())).toBe(false);
  });

  it('writes fn-name fields of a value out, other text through text, and reads them back in', async () => {
    const type: GinTypeDef = {
      name: 'obj',
      props: {
        fn: { type: FN_NAME },
        fns: { type: { name: 'list', generic: { V: FN_NAME } } },
        maybe: { type: { name: 'optional', generic: { T: FN_NAME } } },
        note: { type: { name: 'text' } },
        named: { type: { name: 'x/Hit' } },
      },
    };
    const types = (name: string): GinTypeDef | undefined => (name === 'x/Hit' ? { name: 'obj', props: { name: { type: FN_NAME } } } : undefined);
    const names = modelFnNames({ index, mode: { type: 'tools' }, types });
    const value = { fn: 'fs/read', fns: ['fs/Entry.reveal', 'gone/fn'], maybe: 'hub/fns_search', note: 'try fs/read', named: { name: 'fs/read' }, extra: 'fs/read' };
    await names.learn([value]);
    const out = names.value(value, type);
    expect(out).toEqual({
      fn: 'fs__read', fns: ['fs__Entry__reveal', 'gone__fn'], maybe: 'hub__fns_search', note: 'try fs__read', named: { name: 'fs__read' }, extra: 'fs__read',
    });
    // in: only fn-name fields come back; the model's other text is its own
    expect(names.read({ ...JsonObject.parse(out), note: 'fs__read' }, type)).toEqual({ ...value, fns: ['fs/Entry.reveal', 'gone/fn'], note: 'fs__read', extra: 'fs__read' });
  });

  it('reads a union\'s field by the option its literal fields pick, so a field two options share is read by the right one', async () => {
    const literal = (value: string): GinTypeDef => ({ name: 'literal', generic: { T: { name: 'text' } }, options: { value } });
    const target: GinTypeDef = {
      name: 'or',
      options: {
        types: [
          { name: 'obj', props: { kind: { type: literal('context') }, name: { type: { name: 'text' } } } },
          { name: 'obj', props: { kind: { type: literal('fn') }, name: { type: FN_NAME } } },
        ],
      },
    };
    const type: GinTypeDef = { name: 'obj', props: { about: { type: { name: 'list', generic: { V: target } } } } };
    const names = modelFnNames({ index, mode: { type: 'tools' } });
    const given = { about: [{ kind: 'fn', name: 'hub__fns_search' }, { kind: 'context', name: 'fs/guide' }] };
    expect(names.read(given, type)).toEqual({ about: [{ kind: 'fn', name: 'hub/fns_search' }, { kind: 'context', name: 'fs/guide' }] });
    await names.learn([given]);
    expect(names.value({ about: [{ kind: 'fn', name: 'fs/read' }, { kind: 'context', name: 'fs/guide' }] }, type)).toEqual({ about: [{ kind: 'fn', name: 'fs__read' }, { kind: 'context', name: 'fs/guide' }] });
  });
});

describe('names that are not fns, as the model may write them', () => {
  it('gives a type or a glob in the tools\' spelling its / and . back, and leaves the rest alone', () => {
    expect(slashedName('database__main__expenses')).toBe('database/main.expenses');
    expect(slashedName('database/main.expenses')).toBe('database/main.expenses');
    expect(slashedName('hub__ContentRef')).toBe('hub/ContentRef');
    expect(slashedName('fs__*')).toBe('fs/*');
    expect(slashedName('hub__fns_*')).toBe('hub/fns_*');
    expect(slashedName('expenses')).toBe('expenses');
    expect(slashedName('main.expenses')).toBe('main.expenses');
    expect(slashedName('a____b')).toBe('a____b');
  });

  it('matches a type by its name, the tools\' spelling, or a bare name it ends in', () => {
    expect(typeMatches('database/main.expenses', 'database/main.expenses')).toBe(true);
    expect(typeMatches('database/main.expenses', 'database__main__expenses')).toBe(true);
    expect(typeMatches('database/main.expenses', 'expenses')).toBe(true);
    expect(typeMatches('database/main.expenses', 'main.expenses')).toBe(true);
    expect(typeMatches('database/main.expenses', 'penses')).toBe(false);
    expect(typeMatches('hub/ContentRef', 'ContentRef')).toBe(true);
    expect(typeMatches('database/main.other', 'database__main__expenses')).toBe(false);
  });
});

describe('learning a prompt\'s names', () => {
  it('collects the bare names text asks about (and the shorter ones they end in), never refs or paths', () => {
    expect(bareNamesIn('Call fs/Entry.reveal.more, or fn:fs/write, context:fs/guide, docs/fs/read.md and fs/read.')).toEqual(['fs/Entry.reveal.more', 'fs/Entry.reveal', 'fs/Entry', 'docs/fs', 'fs/read']);
    expect(cutNamesIn(`Use ${modelFnName(LONG)} now, not fs__read.`)).toEqual([modelFnName(LONG)]);
  });

  it('asks the registry once per batch, only about names it hasn\'t met, and spells what it learned', async () => {
    const asked: string[][] = [];
    const registry: ModelFnNameRegistry = {
      fnsAmong: (names) => { asked.push([...names]); return Promise.resolve(new Set(names.filter((name) => name === 'fs/read'))); },
      fnsOf: (models) => { asked.push([...models]); return Promise.resolve(new Map(models.filter((model) => model === modelFnName(LONG)).map((model) => [model, LONG]))); },
    };
    const names = modelFnNames({ index: registry, mode: { type: 'tools' } });
    await names.learn(['Use fs/read and fs/guide.', { nested: [`then ${modelFnName(LONG)}`] }, undefined]);
    expect(asked).toEqual([['fs/read', 'fs/guide'], [modelFnName(LONG)]]);
    await names.learn(['fs/read again, and fs/guide']);
    expect(asked).toHaveLength(2);
    expect(names.text('Use fs/read and fs/guide.')).toBe('Use fs__read and fs/guide.');
    expect(names.fn(modelFnName(LONG))).toBe(LONG);
    // a name it never learned is left as written
    expect(names.text('and fs/write')).toBe('and fs/write');
  });
});

describe('the build\'s check of names in authored text', () => {
  const known = {
    fns: new Set(['fs/read', 'fs/Entry.reveal']), context: new Set(['fs/guide']), types: new Set(['fs/Entry']), systems: new Set(['fs']),
  };
  it('finds refs and bare names of known systems that name nothing, and leaves paths and other systems alone', () => {
    const text = 'Use fs/read, fs/Entry, fs/guide and fs/Entry.reveal. Not fs/raed, fn:fs/gone or context:fs/nope; src/index.ts and other/x are not checked.';
    expect(unresolvedNamesIn(text, known).map((found) => [found.ref, found.name])).toEqual([[undefined, 'fs/raed'], ['fn', 'fs/gone'], ['context', 'fs/nope']]);
  });
});
