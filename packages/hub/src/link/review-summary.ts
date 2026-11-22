/**
 * What a set of contract changes amounts to (`ReviewSummary`), worked out once here for a pending review (the review
 * page) and for an install card (the chat): counts per section in one line ("+3 fns, 1 changed, grants widened, config
 * type changed"), what happened to the grants and the config type, and the risk flags an admin reads first: fns that
 * can now write or delete, new effects on the hub, and new hub calls, secrets, hosts, paths, fns or models granted.
 */
import {
  effectsLine, FnDecl, isKept, ITEM_SECTIONS, registryMode, REVIEW_FLAGS, reviewFlag, strongerMode, SystemGrants,
  type ContractChange, type DeclaredFnFacts, type FnChangeFacts, type FnMode, type GrantsMove, type Json, type RegistryEffect, type ReviewCount, type ReviewFlag, type ReviewFlagKind, type ReviewSummary,
} from '@harness/core';
import { declaredMode } from '../fns/facts.ts';

/** Each section's words, one and many, in the order the line lists them. */
const NOUNS: Readonly<Record<ContractChange['section'], readonly [string, string]>> = {
  fns: ['fn', 'fns'], context: ['context item', 'context items'], types: ['type', 'types'], roots: ['resource root', 'resource roots'],
  kinds: ['kind', 'kinds'], commands: ['command', 'commands'], mentions: ['mention', 'mentions'], hooks: ['hook', 'hooks'], actions: ['action', 'actions'],
  settings: ['setting', 'settings'], attachments: ['attachment', 'attachments'], embedders: ['embedder', 'embedders'], sectioners: ['sectioner', 'sectioners'],
  providers: ['model provider', 'model providers'], registries: ['registry', 'registries'], components: ['component', 'components'], examples: ['example', 'examples'],
  grants: ['grant', 'grants'], config: ['config item', 'config items'],
};

/** The whole-system config items beside the config type, by the suffix of their listed name (`manifestItems`). */
const CONFIG_WORDS: Readonly<Record<string, string>> = { connect: 'connect page', events: 'hub events', resources: 'resource serving' };

/**
 * The mode a fn's declaration amounts to: what it declares, raised by what it creates, updates or removes in the hub
 * (but for what it keeps of what it reads, `FnEffects.keeps`).
 */
export function fnMode(decl: FnDecl): FnMode {
  const least = registryMode((decl.effects?.registry ?? []).filter((effect) => !isKept(effect, decl.effects?.keeps)));
  const own = declaredMode(decl);
  return least === undefined ? own : strongerMode(own, least);
}

const fnOf = (value: Json | undefined): FnDecl | undefined => (value === undefined ? undefined : FnDecl.safeParse(value).data);
const grantsOf = (value: Json | undefined): SystemGrants | undefined => (value === undefined ? undefined : SystemGrants.safeParse(value).data);
const effectKey = (effect: RegistryEffect): string => `${effect.thing}\u0000${effect.action}\u0000${effect.kind ?? ''}`;
/** What `after` has that `before` hasn't. */
const added = (before: readonly string[] | undefined, after: readonly string[] | undefined): string[] => {
  const was = new Set(before ?? []);
  return (after ?? []).filter((value) => !was.has(value));
};

/** The risk flags of the fns that changed: new write and delete fns (or ones that went up to it), and new effects. */
function fnFlags(changes: readonly ContractChange[]): ReviewFlag[] {
  const writes: string[] = [];
  const deletes: string[] = [];
  const effects = new Map<string, RegistryEffect>();
  const effectFns: string[] = [];
  for (const change of changes) {
    if (change.section !== 'fns' || change.change === 'removed') { continue; }
    const after = fnOf(change.after);
    if (after === undefined) { continue; }
    const before = fnOf(change.before);
    const mode = fnMode(after);
    if (before === undefined || fnMode(before) !== mode) {
      if (mode === 'delete') { deletes.push(change.name); } else if (mode === 'write' && (before === undefined || fnMode(before) === 'read')) { writes.push(change.name); }
    }
    const had = new Set((before?.effects?.registry ?? []).map(effectKey));
    const fresh = (after.effects?.registry ?? []).filter((effect) => !had.has(effectKey(effect)));
    if (fresh.length > 0) { effectFns.push(change.name); }
    for (const effect of fresh) { effects.set(effectKey(effect), effect); }
  }
  const flags: ReviewFlag[] = [];
  if (deletes.length > 0) { flags.push(reviewFlag('delete-fns', 'Can delete', deletes)); }
  if (writes.length > 0) { flags.push(reviewFlag('write-fns', 'Can write', writes)); }
  const words = effectsLine([...effects.values()]);
  if (words !== undefined) { flags.push(reviewFlag('effects', 'New effects in', effectFns, words.replace(/\.$/, ''))); }
  return flags;
}

/** How the grants moved, and the flags for what they newly allow. */
export function grantsMove(before: SystemGrants | undefined, after: SystemGrants | undefined): { move: GrantsMove | undefined; flags: ReviewFlag[] } {
  if (after === undefined && before === undefined) { return { move: undefined, flags: [] }; }
  const was = before ?? { hub: [] };
  const now = after ?? { hub: [] };
  const flags: ReviewFlag[] = [];
  const flag = (kind: ReviewFlagKind, label: string, items: readonly string[]): void => { if (items.length > 0) { flags.push(reviewFlag(kind, label, items)); } };
  flag('capabilities', 'New hub calls', added(was.hub, now.hub));
  flag('secrets', 'New secrets', added(was.secrets, now.secrets));
  flag('hosts', 'New hosts', added(was.network, now.network));
  flag('files', 'New paths', [...added(was.files?.read, now.files?.read).map((path) => `read ${path}`), ...added(was.files?.write, now.files?.write).map((path) => `write ${path}`)]);
  flag('calls', 'May call', added(was.calls, now.calls));
  const models = [
    ...(was.models !== undefined && was.models.roles !== undefined && now.models !== undefined && now.models.roles === undefined ? ['any role'] : added(was.models?.roles, now.models?.roles)),
    ...added(was.models?.models, now.models?.models),
    ...raised('a run', was.models?.perRun, now.models?.perRun, was.models !== undefined),
    ...raised('a day', was.models?.perDay, now.models?.perDay, was.models !== undefined),
  ];
  flag('models', 'New models', models);
  const narrowed = grantsWider(was, now);
  if (before === undefined) { return { move: 'added', flags }; }
  const move: GrantsMove = flags.length > 0 ? (narrowed ? 'changed' : 'widened') : narrowed ? 'narrowed' : 'changed';
  return { move, flags };
}

/** A spend limit that went up or away, in words ("more spend a run"). */
function raised(per: string, before: number | undefined, after: number | undefined, limited: boolean): string[] {
  if (!limited || before === undefined) { return []; }
  return after === undefined || after > before ? [`more spend ${per}`] : [];
}

/** Whether `a` allows anything `b` doesn't (so, read the other way round, whether the grants narrowed). */
function grantsWider(a: SystemGrants, b: SystemGrants): boolean {
  return added(b.hub, a.hub).length + added(b.secrets, a.secrets).length + added(b.network, a.network).length + added(b.calls, a.calls).length
    + added(b.files?.read, a.files?.read).length + added(b.files?.write, a.files?.write).length + added(b.models?.roles, a.models?.roles).length + added(b.models?.models, a.models?.models).length > 0;
}

/** Counts per section, in the order the page lists sections. */
function counts(changes: readonly ContractChange[]): ReviewCount[] {
  const order: readonly ContractChange['section'][] = [...ITEM_SECTIONS, 'grants', 'config'];
  return order.flatMap((section) => {
    const of = changes.filter((change) => change.section === section);
    if (of.length === 0) { return []; }
    const count = (kind: ContractChange['change']): number => of.filter((change) => change.change === kind).length;
    return [{ section, added: count('added'), changed: count('changed'), removed: count('removed') }];
  });
}

/** Whether a count's section is one the summary has nouns for. */
function isChangeSection(section: string): section is ContractChange['section'] {
  return Object.hasOwn(NOUNS, section);
}

/** One section's count in words: "+3 fns, 1 changed", "1 type removed". */
function countWords(count: ReviewCount): string {
  if (!isChangeSection(count.section)) { return ''; }
  const [one, many] = NOUNS[count.section];
  const parts: string[] = [];
  const noun = (n: number): string => (n === 1 ? one : many);
  if (count.added > 0) { parts.push(`+${count.added} ${noun(count.added)}`); }
  if (count.changed > 0) { parts.push(parts.length === 0 ? `${count.changed} ${noun(count.changed)} changed` : `${count.changed} changed`); }
  if (count.removed > 0) { parts.push(parts.length === 0 ? `${count.removed} ${noun(count.removed)} removed` : `${count.removed} removed`); }
  return parts.join(', ');
}

/** What a system's contract changes amount to. */
export function reviewSummary(changes: readonly ContractChange[]): ReviewSummary {
  const all = counts(changes);
  const grants = changes.find((change) => change.section === 'grants');
  const moved = grants === undefined ? { move: undefined, flags: [] } : grantsMove(grantsOf(grants.before), grantsOf(grants.after));
  const configType = changes.find((change) => change.section === 'config' && !change.name.includes(' '));
  const otherConfig = changes.filter((change) => change.section === 'config' && change.name.includes(' '));
  const flags = [...fnFlags(changes), ...moved.flags].sort((a, b) => REVIEW_FLAGS.indexOf(a.flag) - REVIEW_FLAGS.indexOf(b.flag));
  const line = [
    ...all.filter((count) => count.section !== 'grants' && count.section !== 'config').map(countWords),
    ...(moved.move === undefined ? [] : [`grants ${moved.move}`]),
    ...(configType === undefined ? [] : [`config type ${configType.change}`]),
    ...otherConfig.map((change) => `${CONFIG_WORDS[change.name.slice(change.name.lastIndexOf(' ') + 1)] ?? change.name} ${change.change}`),
  ].join(', ');
  return {
    line: line === '' ? 'No changes' : line, counts: all, flags,
    ...(moved.move === undefined ? {} : { grants: moved.move }),
    ...(configType === undefined ? {} : { config: configType.change }),
  };
}

/** What a fn's declaration says about it: its mode, effects, the types it reads and writes, what it uses and costs. */
export function declaredFacts(decl: FnDecl): DeclaredFnFacts {
  const effects = effectsLine(decl.effects?.registry ?? []);
  return {
    mode: fnMode(decl), reads: decl.effects?.reads ?? [], writes: decl.effects?.writes ?? [], deps: decl.deps,
    ...(effects === undefined ? {} : { effects }),
    ...(decl.limits.cost === undefined ? {} : { cost: decl.limits.cost }),
    ...(decl.effects?.free === undefined ? {} : { free: decl.effects.free }),
  };
}

/** Each changed fn's facts before and after, in the order of the changes. */
export function fnChangeFacts(changes: readonly ContractChange[]): FnChangeFacts[] {
  return changes.flatMap((change) => {
    if (change.section !== 'fns') { return []; }
    const before = fnOf(change.before);
    const after = fnOf(change.after);
    return [{ name: change.name, ...(before === undefined ? {} : { before: declaredFacts(before) }), ...(after === undefined ? {} : { after: declaredFacts(after) }) }];
  });
}
