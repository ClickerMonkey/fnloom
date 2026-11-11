/**
 * The pickers' answers (`pick`): every option a source has that the asker may see, ranked by how well it matches
 * what they typed (fns are searched in the hub's database, `fns/search.ts`, by words and meaning), or, with `values`, those values' options so the web can label the chips it holds (a value that
 * resolves to nothing, or to something the asker can't see, comes back `missing`).
 */
import { QualifiedName, type ActorId, type PickOption, type PickQuery, type PickSource } from '@harness/core';
import type { AccessScope, AccessService } from '../../access/index.ts';
import { seesContextAs } from '../../access/scope.ts';
import type { Catalog } from '../../catalog/index.ts';
import type { FnSearch } from '../../fns/index.ts';
import type { LlmGateway } from '../../execution/index.ts';
import type { QueryEnv } from '../../query/env.ts';
import type { HubStore } from '../../store/index.ts';

/** What `pick` reads. */
export interface PickerDeps {
  readonly access: Pick<AccessService, 'scope'>;
  readonly catalog: Pick<Catalog, 'fn'>;
  /** The fns search, which fn pickers ask instead of scanning the catalog. */
  readonly fns: Pick<FnSearch, 'search'>;
  readonly store: HubStore;
  readonly llm: Pick<LlmGateway, 'models'>;
  readonly settings: Pick<QueryEnv, 'HARNESS_PICK_SCAN' | 'HARNESS_PICK_LIMIT'>;
}

/** How well an option matches typed text: 0 for no match, higher for better (exact, prefix, word start, anywhere). */
export function matchScore(option: PickOption, text: string): number {
  const needle = text.trim().toLowerCase();
  if (needle === '') { return 1; }
  const fields = [option.value, option.label].map((field) => field.toLowerCase());
  if (fields.some((field) => field === needle)) { return 5; }
  if (fields.some((field) => field.startsWith(needle))) { return 4; }
  if (fields.some((field) => field.split(/[\s/._:-]+/).some((word) => word.startsWith(needle)))) { return 3; }
  if (fields.some((field) => field.includes(needle))) { return 2; }
  return option.hint?.toLowerCase().includes(needle) === true ? 1 : 0;
}

/** Answer a picker's query for the asker. */
export async function pick(deps: PickerDeps, asker: ActorId, query: PickQuery): Promise<PickOption[]> {
  const scope = await deps.access.scope(asker);
  if (query.source === 'fn') return pickFns(deps, { actor: asker, access: scope }, query);
  const options = await optionsOf(deps, scope, query.source);
  if (query.values !== undefined) {
    const byValue = new Map(options.map((option) => [option.value, option]));
    return query.values.map((value) => byValue.get(value) ?? { value, label: value, missing: true });
  }
  const text = query.text ?? '';
  return options
    .map((option, order) => ({ option, order, score: matchScore(option, text) }))
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, query.limit ?? deps.settings.HARNESS_PICK_LIMIT)
    .map((ranked) => ranked.option);
}

/** A fn as an option. */
function fnOption(fn: { readonly name: string; readonly description: string }): PickOption {
  return { value: fn.name, label: fn.name, hint: fn.description, icon: 'fn' };
}

/** Fns: the values' own fns, or the fns search's best matches (by name without text), unavailable ones too. */
async function pickFns(deps: PickerDeps, asker: { readonly actor: ActorId; readonly access: AccessScope }, query: PickQuery): Promise<PickOption[]> {
  if (query.values !== undefined) {
    const out: PickOption[] = [];
    for (const value of query.values) {
      const name = QualifiedName.safeParse(value);
      const fn = name.success ? await deps.catalog.fn(name.data) : undefined;
      out.push(fn !== undefined && asker.access.seesFn(fn) ? fnOption({ name: fn.name, description: fn.decl.description }) : { value, label: value, missing: true });
    }
    return out;
  }
  const text = query.text?.trim() ?? '';
  const page = await deps.fns.search({
    items: ['fn'], available: false, limit: query.limit ?? deps.settings.HARNESS_PICK_LIMIT, ...(text === '' ? { order: 'name' as const } : { text }),
  }, asker);
  return page.items.map(fnOption);
}

/** Every option of a source the scope sees, in a stable order (fns are searched instead, `pickFns`). */
async function optionsOf(deps: PickerDeps, scope: AccessScope, source: Exclude<PickSource, 'fn'>): Promise<PickOption[]> {
  const { store } = deps;
  const limit = deps.settings.HARNESS_PICK_SCAN;
  switch (source) {
    case 'context': {
      const rows = await store.table('context').find({ limit });
      return rows.items.filter((row) => row.disabled !== true && seesContextAs(scope, row)).map((row) => ({ value: row.name, label: row.name, hint: row.decl.description }));
    }
    case 'system': {
      const rows = await store.table('systems').find({ limit });
      return rows.items.filter((row) => row.status !== 'removed' && scope.seesSystem(row.name)).map((row) => ({ value: row.name, label: row.name, hint: row.description }));
    }
    case 'person':
    case 'group': {
      const rows = await store.table('actors').find({ where: { kind: source === 'person' ? 'user' : 'group' }, limit });
      return rows.items.map((actor) => ({ value: actor.id, label: actor.name, ...(actor.kind === 'user' ? { hint: actor.email } : {}), icon: source }));
    }
    case 'model': {
      const models = await deps.llm.models();
      return models.map((model) => ({ value: model.id, label: model.name, hint: model.provider }));
    }
    case 'resource': {
      const rows = await store.table('resources').find({ limit });
      return rows.items.filter((row) => scope.seesUri(row.uri)).map((row) => ({ value: row.uri, label: row.stat.name, hint: row.uri }));
    }
    case 'type': {
      const rows = await store.table('types').find({ limit });
      return rows.items.filter((row) => scope.seesType(row)).map((row) => ({ value: row.name, label: row.name, hint: row.description }));
    }
    case 'kind': {
      const rows = await store.table('kinds').find({ limit });
      const kinds = rows.items.filter((row) => scope.seesSystem(row.system)).map((row) => ({ value: row.name, label: row.name, hint: row.decl.description }));
      return [{ value: 'native', label: 'native', hint: 'A fn its system implements in code.' }, ...kinds];
    }
  }
}
