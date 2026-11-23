/**
 * One spelling in every field (scenario iteration 3, item 1): every hub arg that names a fn takes the name the model's
 * tools spell it by, read back at the boundary before the fn parses its args. Each call below is one iteration 2's chat
 * model made, refused then because the field wanted the `system/name` form.
 */
import { describe, expect, it } from 'vitest';
import { FnNameIndex, FnSearchArgs, GinTypeDef, MakeWidgetArgs, type Json, modelFnNames, QualifiedName, RememberArgs } from '@harness/core';
import { ginAs } from './zod-gin.ts';
import { hub } from './hub.ts';

const fn = (name: string): QualifiedName => QualifiedName.parse(name);
const index = FnNameIndex.of([fn('hub/forget'), fn('hub/memory_update'), fn('hub/session_create'), fn('web/read'), fn('database/main.notes_create'), fn('database/main.notes_by_day'), fn('code/total_with_tax')]);

/** A fn's args as the model sent them, read back as the hub reads them. */
async function read(args: { toJSON(): unknown }, sent: Json): Promise<Json> {
  const names = modelFnNames({ index, mode: { type: 'tools' } });
  await names.learn([sent]);
  return names.read(sent, GinTypeDef.parse(args.toJSON()));
}

describe('one spelling in every field', () => {
  it('hub/fns_search takes `names` as the tools spell them', async () => {
    const sent = { text: 'forget remove delete a memory', systems: ['hub'], names: ['hub__forget', 'hub__memory_update'], order: 'name', limit: 10 };
    const parsed = FnSearchArgs.parse(await read(hub.fns.fns_search.args, sent));
    expect(parsed.names).toEqual(['hub/forget', 'hub/memory_update']);
    // a saved fn's name, and the qualified form code and people use, alike
    expect(FnSearchArgs.parse(await read(hub.fns.fns_search.args, { names: ['database__main__notes_create', 'web/read'] })).names).toEqual(['database/main.notes_create', 'web/read']);
  });

  it('hub/fns_search takes `types` as a table\'s name, a type, or the tools\' spelling of one', async () => {
    for (const reads of [['notes'], ['database/main.notes'], ['database__main__notes']]) {
      expect(FnSearchArgs.safeParse(await read(hub.fns.fns_search.args, { text: 'total by day', types: { reads }, modes: ['read'] })).success).toBe(true);
    }
  });

  it('widgets take `source`, `fns` and `widget` as the tools spell them', async () => {
    const args = ginAs(MakeWidgetArgs);
    const sent = { source: 'database__main__notes_by_day', request: 'A line chart per day.', args: { from: '2026-11-16', to: '2026-11-22' }, fns: ['database__main__notes_create'], widget: 'widgets__notes_chart', show: true };
    expect(MakeWidgetArgs.parse(await read(args, sent))).toMatchObject({ source: 'database/main.notes_by_day', fns: ['database/main.notes_create'], widget: 'widgets/notes_chart' });
  });

  it('a memory\'s `fns` and the fn it is `about` take the tools\' spelling; context keys keep theirs', async () => {
    const args = hub.fns.remember.args;
    const sent = { text: 'Use this program for totals with tax.', scope: 'user', fns: ['code__total_with_tax'], about: [{ kind: 'fn', name: 'code__total_with_tax' }, { kind: 'context', name: 'code/guide' }] };
    expect(RememberArgs.parse(await read(args, sent))).toMatchObject({ fns: ['code/total_with_tax'], about: [{ kind: 'fn', name: 'code/total_with_tax' }, { kind: 'context', name: 'code/guide' }] });
  });

  it('shows the model those fields in the one spelling', async () => {
    const names = modelFnNames({ index, mode: { type: 'tools' } });
    const page = { names: ['hub/forget'] };
    await names.learn([page]);
    expect(names.value(page, GinTypeDef.parse(hub.fns.fns_search.args.toJSON()))).toEqual({ names: ['hub__forget'] });
  });
});
