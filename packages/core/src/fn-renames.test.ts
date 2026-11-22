import { describe, expect, it } from 'vitest';
import { CtxSearchArgs, ctxSearchQuery, FnSearchArgs, fnsSearchQuery } from './fn-facts.ts';
import { FN_RENAME_TABLES, HUB_FN_RENAMES, QUALIFIED_FN_RENAMES, renamedFn, renamedHubLocal, renameFnsIn } from './fn-renames.ts';
import { HUB_TABLES } from './records/tables.ts';

describe('the prefix rule\'s renames', () => {
  it('renames every hub fn about fns to fns_ and every one about context to ctx_', () => {
    for (const [from, to] of Object.entries(HUB_FN_RENAMES)) {
      expect(to).toMatch(/^(fns|ctx)_/);
      expect(from).not.toBe(to);
    }
    expect(renamedFn('hub/load_fns')).toBe('hub/fns_load');
    expect(renamedFn('hub/load_context')).toBe('hub/ctx_load');
    expect(renamedFn('hub/context_crawl')).toBe('hub/ctx_crawl');
    // only the hub's: another system's fn of the same local name, a kept name and a new name are as they are
    expect(renamedFn('fs/load_fns')).toBe('fs/load_fns');
    expect(renamedFn('hub/fns_search')).toBe('hub/fns_search');
    expect(renamedFn('hub/fns_load')).toBe('hub/fns_load');
    expect(renamedHubLocal('save_fn')).toBe('fns_save');
    expect(renamedHubLocal('remember')).toBe('remember');
    expect(renamedHubLocal('toString')).toBe('toString');
    expect(QUALIFIED_FN_RENAMES.size).toBe(Object.keys(HUB_FN_RENAMES).length);
  });

  it('rewrites stored values deep, exact names only, and keeps an unchanged value as it is', () => {
    const session = { id: 'ses_1', tools: ['hub/load_fns', 'fs/read', 'hub/fn_examples'], context: ['fs/guide'] };
    expect(renameFnsIn(session)).toEqual({ id: 'ses_1', tools: ['hub/fns_load', 'fs/read', 'hub/fns_examples'], context: ['fs/guide'] });
    // a policy's fn match, an approval and keys that are names
    expect(renameFnsIn({ target: { fn: 'hub/save_fn' }, fn: 'hub/context_get' })).toEqual({ target: { fn: 'hub/fns_save' }, fn: 'hub/ctx_get' });
    expect(renameFnsIn({ 'hub/fn_metrics': 3 })).toEqual({ 'hub/fns_metrics': 3 });
    // patterns and text that mention a name stay
    expect(renameFnsIn(['hub/*', 'Use hub/load_fns first.'])).toEqual(['hub/*', 'Use hub/load_fns first.']);
    const unchanged = { tools: ['fs/read'], n: 1, ok: true, none: null };
    expect(renameFnsIn(unchanged)).toBe(unchanged);
  });

  it('names only tables the store has', () => {
    for (const table of [...FN_RENAME_TABLES.rows, ...FN_RENAME_TABLES.hubLocal]) expect(Object.hasOwn(HUB_TABLES, table)).toBe(true);
  });
});

describe('the two searches for the model', () => {
  it('fns_search asks the one search for fns only, and takes no item kind', () => {
    const args = FnSearchArgs.parse({ text: 'read a file', items: ['context'], kinds: ['database/query'] });
    expect(args).not.toHaveProperty('items');
    expect(fnsSearchQuery(args)).toEqual({ text: 'read a file', kinds: ['database/query'], items: ['fn'] });
    expect(FnSearchArgs.shape.kinds.description).toContain('unless the person asks for a kind');
  });

  it('ctx_search asks it for context only: origins and tags as the context list\'s filters, scopes as they are', () => {
    const args = CtxSearchArgs.parse({ text: 'diet', origins: ['memory'], scopes: ['user'], tags: ['food'], kinds: ['x/y'] });
    expect(args).not.toHaveProperty('kinds');
    expect(ctxSearchQuery(args)).toEqual({
      text: 'diet', scopes: ['user'], items: ['context'],
      filters: [{ field: 'origin', op: 'in', values: ['memory'] }, { field: 'tags', op: 'in', values: ['food'] }],
    });
    expect(ctxSearchQuery(CtxSearchArgs.parse({ text: 'tables' }))).toEqual({ text: 'tables', items: ['context'] });
    expect(CtxSearchArgs.safeParse({ origins: ['web'] }).success).toBe(false);
  });
});
