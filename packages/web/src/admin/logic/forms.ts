/**
 * The admin forms' drafts and how each becomes the body its endpoint takes. A draft is what the inputs hold (text as
 * typed; writable, since the inputs edit it); `…Body` builds the candidate and checks it with the endpoint's own body
 * schema from the spec, so the form and the hub agree and a schema change reaches the form. Problems come back one
 * per top-level field.
 */
import {
  InstallSource, ProviderInput, type ActorKind, type ActorMatch, type Approver, type BudgetPeriod, type BudgetRule, type LimitLevel, type ModelCategory, type Policy, type Priority, type PriorityLevel,
  type PriorityRule,
} from '@harness/core';
import type { z } from 'zod';
import { checkForm, type FieldProblems } from '../../state/problems.ts';
import { hubWebSpec } from '@harness/core';
import { WINDOWS } from './limits.ts';

/** Every key of any member of a union of objects. */
type KeysOfUnion<U> = U extends unknown ? keyof U : never;

/** A checked body, or a problem per field. */
export type Checked<T, K extends string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: FieldProblems<K> };

/** The bodies the forms send, straight from the spec. */
export const BODIES = {
  setBudget: hubWebSpec.endpoints.setBudget.cfg.body,
  setPriority: hubWebSpec.endpoints.setPriority.cfg.body,
  setPolicy: hubWebSpec.endpoints.setPolicy.cfg.body,
  setModelCategory: hubWebSpec.endpoints.setModelCategory.cfg.body,
  createPairingToken: hubWebSpec.endpoints.createPairingToken.cfg.body,
  upgradeSystem: hubWebSpec.endpoints.upgradeSystem.cfg.body,
} as const;

export type BudgetBody = z.output<typeof BODIES.setBudget>;
export type PriorityBody = z.output<typeof BODIES.setPriority>;
export type PolicyBody = z.output<typeof BODIES.setPolicy>;
export type CategoryBody = z.output<typeof BODIES.setModelCategory>;

/** Text to an optional number: '' is absent; anything else must read as a number (or the schema says so). */
const numberOf = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));
/** Drop absent fields, so optional ones are left out rather than sent as undefined. */
const present = (entries: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined && v !== ''));
const toText = (value: number | undefined): string => (value === undefined ? '' : String(value));

// ─── Where a rule lives ───────────────────────────────────────────────────────

/** A scope as the inputs hold it: the level, and the id or name it points at (none for the hub). */
export interface ScopeDraft<L extends string> {
  level: L;
  target: string;
}

/** The levels whose target is an actor picked from a list; the rest are typed. */
export const ACTOR_LEVELS = { group: 'group', user: 'user' } as const satisfies Partial<Record<LimitLevel, ActorKind>>;

/** The candidate scope object for a level and target. The scope's key is its level's name. */
function scopeOf(draft: ScopeDraft<string>): Record<string, unknown> {
  return draft.level === 'hub' ? { scope: 'hub' } : { scope: draft.level, [draft.level]: draft.target.trim() };
}

/** A scope back to its draft. */
function scopeDraftOf<L extends string>(scope: { readonly scope: L } & Readonly<Record<string, unknown>>): ScopeDraft<L> {
  const target = scope[scope.scope];
  return { level: scope.scope, target: typeof target === 'string' ? target : '' };
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

/** How a budget's period is chosen: one of `BudgetPeriod`'s literals, or the key of its object form (`window`). */
export type PeriodKind = Exclude<BudgetPeriod, object> | KeysOfUnion<Extract<BudgetPeriod, object>>;

export interface BudgetDraft {
  scope: ScopeDraft<LimitLevel>;
  period: PeriodKind;
  /** The window's length, ms. */
  window: number;
  maxCost: string;
  maxTokens: string;
  maxCalls: string;
  /** Seconds, for per-message budgets. */
  maxTime: string;
  share: NonNullable<BudgetRule['share']>;
  onLimit: BudgetRule['onLimit'];
}

/** A new budget's draft, or an existing one's. */
export function budgetDraft(rule?: BudgetRule): BudgetDraft {
  const period = rule?.period;
  return {
    scope: rule === undefined ? { level: 'hub', target: '' } : scopeDraftOf(rule.target),
    period: period === undefined || typeof period === 'object' ? 'window' : period,
    window: period !== undefined && typeof period === 'object' ? period.window : WINDOWS[1].ms,
    maxCost: rule === undefined ? '' : String(rule.maxCost),
    maxTokens: toText(rule?.maxTokens),
    maxCalls: toText(rule?.maxCalls),
    maxTime: rule?.maxTime === undefined ? '' : String(rule.maxTime / 1_000),
    share: rule?.share ?? 'pooled',
    onLimit: rule?.onLimit ?? 'refuse',
  };
}

/** A budget draft to the body `setBudget` takes. */
export function budgetBody(draft: BudgetDraft): Checked<BudgetBody, Extract<keyof BudgetBody, string>> {
  const period: BudgetPeriod = draft.period === 'window' ? { window: draft.window } : draft.period;
  const seconds = numberOf(draft.maxTime);
  return checkForm(BODIES.setBudget, present({
    target: scopeOf(draft.scope),
    period,
    maxCost: numberOf(draft.maxCost) ?? Number.NaN,
    maxTokens: numberOf(draft.maxTokens),
    maxCalls: numberOf(draft.maxCalls),
    maxTime: draft.period === 'per-turn' && seconds !== undefined ? Math.round(seconds * 1_000) : undefined,
    share: draft.scope.level === 'group' ? draft.share : undefined,
    onLimit: draft.onLimit,
  }));
}

// ─── Priority rules ───────────────────────────────────────────────────────────

export interface PriorityDraft {
  scope: ScopeDraft<PriorityLevel>;
  default: Priority | '';
  max: Priority | '';
}

export function priorityDraft(rule?: PriorityRule): PriorityDraft {
  return {
    scope: rule === undefined ? { level: 'hub', target: '' } : scopeDraftOf(rule.target),
    default: rule?.default ?? '',
    max: rule?.max ?? '',
  };
}

/** A priority draft to the body `setPriority` takes. At least one of default and max must be set. */
export function priorityBody(draft: PriorityDraft): Checked<PriorityBody, Extract<keyof PriorityBody, string>> {
  if (draft.default === '' && draft.max === '') { return { ok: false, problems: { default: 'Set a default, a ceiling, or both.' } }; }
  return checkForm(BODIES.setPriority, present({ target: scopeOf(draft.scope), default: draft.default, max: draft.max }));
}

// ─── Policies ─────────────────────────────────────────────────────────────────

/** How the subject is chosen: the key of an `ActorMatch` form. */
export type SubjectKind = KeysOfUnion<ActorMatch>;
/** Who answers an "ask". */
export type ApproverKind = Approver['by'];

export interface PolicyDraft {
  description: string;
  subject: SubjectKind;
  /** The actor or group id, or the actor kind. */
  subjectValue: string;
  fn: string;
  system: string;
  kind: string;
  /** Comma-separated. */
  tags: string;
  effect: Policy['decision']['effect'];
  reason: string;
  approver: ApproverKind;
  /** The actor or group id, or the judge fn. */
  approverValue: string;
  quorum: string;
  priority: string;
}

export function policyDraft(policy?: Policy): PolicyDraft {
  const subject = policy?.subject;
  const decision = policy?.decision;
  const approver = decision?.effect === 'ask' ? decision.approver : undefined;
  return {
    description: policy?.description ?? '',
    subject: subject === undefined || 'everyone' in subject ? 'everyone' : 'actor' in subject ? 'actor' : 'group' in subject ? 'group' : 'kind',
    subjectValue: subject === undefined || 'everyone' in subject ? '' : 'actor' in subject ? subject.actor : 'group' in subject ? subject.group : subject.kind,
    fn: policy?.target.fn ?? '',
    system: policy?.target.system ?? '',
    kind: policy?.target.kind ?? '',
    tags: policy?.target.tags?.join(', ') ?? '',
    effect: decision?.effect ?? 'ask',
    reason: decision?.effect === 'deny' ? decision.reason : '',
    approver: approver?.by ?? 'turn-user',
    approverValue: approver === undefined ? '' : approver.by === 'actor' ? approver.actor : approver.by === 'group' ? approver.group : approver.by === 'judge' ? approver.fn : '',
    quorum: approver?.by === 'group' ? toText(approver.quorum) : '',
    priority: String(policy?.priority ?? 0),
  };
}

/** A policy draft to the body `setPolicy` takes. */
export function policyBody(draft: PolicyDraft): Checked<PolicyBody, Extract<keyof PolicyBody, string>> {
  const value = draft.subjectValue.trim();
  const subject = draft.subject === 'everyone' ? { everyone: true } : { [draft.subject]: value };
  const tags = draft.tags.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const target = present({ fn: draft.fn.trim(), system: draft.system.trim(), kind: draft.kind.trim(), tags: tags.length === 0 ? undefined : tags });
  const approverValue = draft.approverValue.trim();
  const approver = draft.approver === 'actor' ? { by: 'actor', actor: approverValue }
    : draft.approver === 'group' ? present({ by: 'group', group: approverValue, quorum: numberOf(draft.quorum) })
      : draft.approver === 'judge' ? { by: 'judge', fn: approverValue }
        : { by: draft.approver };
  const decision = draft.effect === 'allow' ? { effect: 'allow' } : draft.effect === 'deny' ? { effect: 'deny', reason: draft.reason.trim() } : { effect: 'ask', approver };
  if (draft.effect === 'deny' && draft.reason.trim() === '') { return { ok: false, problems: { decision: 'Say why, for the people it stops.' } }; }
  if (draft.description.trim() === '') { return { ok: false, problems: { description: 'Required.' } }; }
  return checkForm(BODIES.setPolicy, { description: draft.description.trim(), subject, target, decision, priority: numberOf(draft.priority) ?? 0 });
}

// ─── Model categories ─────────────────────────────────────────────────────────

export interface CategoryDraft {
  name: string;
  description: string;
  models: readonly string[];
}

export function categoryDraft(category?: ModelCategory): CategoryDraft {
  return { name: category?.name ?? '', description: category?.description ?? '', models: category?.models ?? [] };
}

export function categoryBody(draft: CategoryDraft): Checked<CategoryBody, Extract<keyof CategoryBody, string>> {
  if (draft.name.trim() === '') { return { ok: false, problems: { name: 'Required.' } }; }
  if (draft.models.length === 0) { return { ok: false, problems: { models: 'Add at least one model.' } }; }
  return checkForm(BODIES.setModelCategory, { name: draft.name.trim(), description: draft.description.trim(), models: [...draft.models] });
}

// ─── Providers ────────────────────────────────────────────────────────────────

/** The provider kinds, from the input schema. */
export type ProviderKindInput = ProviderInput['provider'];
/** Every field any provider takes, besides its kind. */
export type ProviderField = Exclude<KeysOfUnion<ProviderInput>, 'provider'>;

/** Every provider field's label, and whether it is a secret. Adding a field to `ProviderInput` breaks this until it is named. */
export const PROVIDER_FIELDS = {
  apiKey: { label: 'API key', secret: true },
  baseURL: { label: 'Base URL', secret: false },
  region: { label: 'Region', secret: false },
  credentials: { label: 'Credentials', secret: true },
} as const satisfies Record<ProviderField, { readonly label: string; readonly secret: boolean }>;

/** Every provider kind's name. */
export const PROVIDER_NAME = { openai: 'OpenAI', openrouter: 'OpenRouter', aws: 'AWS Bedrock', replicate: 'Replicate' } as const satisfies Record<ProviderKindInput, string>;

const isProviderField = (key: string): key is ProviderField => key in PROVIDER_FIELDS;

/** The input schema of one provider kind. */
function providerSchema(kind: ProviderKindInput) {
  const schema = ProviderInput.options.find((option) => option.shape.provider.value === kind);
  if (schema === undefined) { throw new Error(`No provider input schema for ${kind}`); }
  return schema;
}

/** The fields a provider kind takes, in schema order, with whether each is required. */
export function providerFields(kind: ProviderKindInput): readonly { readonly name: ProviderField; readonly label: string; readonly secret: boolean; readonly required: boolean }[] {
  const shape: Readonly<Record<string, z.ZodType>> = providerSchema(kind).shape;
  return Object.entries(shape).flatMap(([name, field]) => (isProviderField(name)
    ? [{ name, ...PROVIDER_FIELDS[name], required: !field.safeParse(undefined).success }]
    : []));
}

/** A provider's fields as typed, to the body `configureProvider` takes. */
export function providerBody(kind: ProviderKindInput, fields: Readonly<Partial<Record<ProviderField, string>>>): Checked<ProviderInput, ProviderField> {
  const values = present(Object.fromEntries(providerFields(kind).map((f) => [f.name, fields[f.name]?.trim()])));
  const checked = checkForm(providerSchema(kind), { provider: kind, ...values });
  if (checked.ok) { return { ok: true, value: checked.value }; }
  const problems: FieldProblems<ProviderField> = {};
  for (const [key, message] of Object.entries(checked.problems)) { if (isProviderField(key)) { problems[key] = message; } }
  return { ok: false, problems };
}

// ─── Installing and pairing ───────────────────────────────────────────────────

/** Every install field. */
export type InstallField = KeysOfUnion<InstallSource>;

/** Where an installed system comes from: a package, a folder, or a git repository. Each names the field that tells its `InstallSource` form apart. */
export const INSTALL_KINDS = ['package', 'path', 'git'] as const satisfies readonly InstallField[];
export type InstallKind = (typeof INSTALL_KINDS)[number];

export interface InstallDraft {
  kind: InstallKind;
  fields: Readonly<Partial<Record<InstallField, string>>>;
}

/** The input schema of one install kind: the option of `InstallSource` keyed by it. */
function installSchema(kind: InstallKind) {
  const schema = InstallSource.options.find((option) => kind in option.shape);
  if (schema === undefined) { throw new Error(`No install source schema for ${kind}`); }
  return schema;
}

/** The fields of an install kind, in schema order. */
export function installFields(kind: InstallKind): readonly InstallField[] {
  return Object.keys(installSchema(kind).shape).filter(isInstallField);
}

/** Every install field, so a field added to `InstallSource` breaks this until it is named. */
const INSTALL_FIELD_NAMES = { package: true, version: true, path: true, git: true, ref: true } as const satisfies Record<InstallField, true>;
const isInstallField = (key: string): key is InstallField => Object.hasOwn(INSTALL_FIELD_NAMES, key);

/** An install draft to the `source` `installSystem` takes. Every field of a source is needed, so none may be blank. */
export function installSource(draft: InstallDraft): Checked<InstallSource, InstallField> {
  const fields = installFields(draft.kind);
  const values = Object.fromEntries(fields.map((field) => [field, (draft.fields[field] ?? '').trim()]));
  const checked = checkForm(installSchema(draft.kind), values);
  const found: Readonly<Record<string, string | undefined>> = checked.ok ? {} : checked.problems;
  const problems: FieldProblems<InstallField> = {};
  for (const field of fields) {
    const message = values[field] === '' ? 'Required.' : found[field];
    if (message !== undefined) { problems[field] = message; }
  }
  if (checked.ok && Object.keys(problems).length === 0) { return { ok: true, value: checked.value }; }
  return { ok: false, problems };
}

/** How long a pairing token lasts, to choose from (ms). */
export const TOKEN_LIFETIMES = [
  { label: '15 minutes', ms: 900_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '1 day', ms: 86_400_000 },
] as const;

export type TokenBody = z.output<typeof BODIES.createPairingToken>;

/** A token request: an optional name it may claim, and how long it lasts. */
export function tokenBody(name: string, expiresIn: number): Checked<TokenBody, Extract<keyof TokenBody, string>> {
  const trimmed = name.trim();
  const checked = checkForm(BODIES.createPairingToken, trimmed === '' ? { expiresIn } : { name: trimmed, expiresIn });
  return checked.ok ? checked : { ok: false, problems: { ...checked.problems, ...(checked.problems.name === undefined ? {} : { name: 'Lowercase letters, digits and dashes, starting with a letter.' }) } };
}
