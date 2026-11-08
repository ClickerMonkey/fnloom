/**
 * Every table the hub stores, by name, with the schema of one row and the column that keys it. The store port
 * (`HubStore` in the hub) is typed by this map, and the SQLite implementation parses every row it reads with the
 * row's schema, so a table that drifts from its record fails loudly.
 */
import { z } from 'zod';
import { Actor, ActorSetting, Approval, AuthSession, Credential, Membership, Policy } from './actors.ts';
import { ChatMessage, Session } from './chat.ts';
import { IndexEntry, Notification, PushSubscription, ResourceRecord, SectionRule } from './content.ts';
import { DeliveryRecord, HandlerCall, LlmInteraction, Run, StateField, Turn } from './runs.ts';
import { BudgetRule, LedgerEntry, ModelCategory, PriorityRule, ProviderRecord, Reservation, Secret } from './spend.ts';
import { ContextRecord, FnRecord, KindRecord, PairingRequest, PairingToken, SystemManifest, SystemRecord, TypeRecord } from './systems.ts';
import { Section } from '../resources.ts';
import { ContextLink } from '../context-graph.ts';
import { FnMetricsDay } from '../metrics.ts';
import { ModelCall, type ModelRole, ModelRoleRecord } from '../model-calls.ts';
import { ModelCalibration, ModelLimitsRecord } from '../modes.ts';
import { InstanceRecord } from '../package.ts';
import { FormRecord } from '../resource-forms.ts';
import { HubMcp } from './mcps.ts';
import { AutoPairSecret } from '../auto-pair.ts';
import { HubOption } from '../suggestions.ts';
import { ResourceUri } from '../resources.ts';

/** A stored section: a resource's section at one version, with the hash of its text. */
export const SectionRow = Section.extend({ uri: ResourceUri, version: z.string(), hash: z.string() });
export type SectionRow = z.infer<typeof SectionRow>;

/** Join parts into one key (`\u0000` between them). Table keys use it; so may in-memory maps keyed by several parts. */
export const compositeKey = (...parts: readonly string[]): string => parts.join('\u0000');

/** The fields of a row whose values are strings: the ones a table can be keyed by. */
export type StringField<Row> = { [P in keyof Row]-?: Row[P] extends string ? P : never }[keyof Row] & string;

/** The parts of a composite key: the row's key fields, by name, so their order is never restated. */
export type KeyParts<Row, F extends keyof Row> = Readonly<Pick<Row, F>>;

/**
 * One table: its row schema, the fields that key it (in order), and the two ways to make the stored key: from a
 * whole row, or from what a reader has (`Key`: the key field's own branded value, or the parts of a composite key).
 * `HUB_TABLES` is the single source of truth for every key, so a reader never joins a key by hand.
 */
export interface TableDef<S extends z.ZodType, Key> {
  readonly row: S;
  /** The key fields, in the order the stored key joins them. */
  readonly fields: readonly string[];
  /** The stored key of a row. */
  readonly rowKey: (row: z.infer<S>) => string;
  /** The stored key from a reader's key. */
  readonly key: (key: Key) => string;
}

/** A table keyed by one string field: readers pass that field's value (a branded id, a name, a uri). */
const byField = <S extends z.ZodType, F extends StringField<z.infer<S>>>(row: S, field: F): TableDef<S, z.infer<S>[F]> => ({
  row,
  fields: [field],
  rowKey: (r) => String(r[field]),
  key: (key) => String(key),
});

/** A table keyed by several string fields: readers pass the parts by name. */
const byFields = <S extends z.ZodType, const F extends readonly [StringField<z.infer<S>>, StringField<z.infer<S>>, ...Array<StringField<z.infer<S>>>]>(
  row: S,
  ...fields: F
): TableDef<S, KeyParts<z.infer<S>, F[number]>> => {
  const join = (parts: KeyParts<z.infer<S>, F[number]>): string => compositeKey(...fields.map((field) => String(parts[field])));
  return { row, fields, rowKey: join, key: join };
};

/** Every table, by name. */
export const HUB_TABLES = {
  actors: byField(Actor, 'id'),
  memberships: byFields(Membership, 'group', 'user'),
  credentials: byFields(Credential, 'user', 'kind'),
  authSessions: byField(AuthSession, 'id'),
  actorSettings: byFields(ActorSetting, 'setting', 'actor'),
  policies: byField(Policy, 'id'),
  approvals: byField(Approval, 'id'),
  systems: byField(SystemRecord, 'name'),
  manifests: byField(SystemManifest, 'system'),
  pairings: byField(PairingRequest, 'id'),
  pairingTokens: byField(PairingToken, 'id'),
  types: byField(TypeRecord, 'name'),
  kinds: byField(KindRecord, 'name'),
  fns: byField(FnRecord, 'name'),
  context: byField(ContextRecord, 'name'),
  sessions: byField(Session, 'id'),
  messages: byField(ChatMessage, 'id'),
  turns: byField(Turn, 'id'),
  runs: byField(Run, 'id'),
  handlerCalls: byField(HandlerCall, 'id'),
  stateFields: byFields(StateField, 'session', 'system', 'name', 'type'),
  deliveries: byField(DeliveryRecord, 'id'),
  llmInteractions: byField(LlmInteraction, 'id'),
  resources: byField(ResourceRecord, 'uri'),
  sections: byFields(SectionRow, 'uri', 'version', 'key'),
  sectionRules: byField(SectionRule, 'id'),
  index: byFields(IndexEntry, 'embedder', 'kind', 'key'),
  secrets: byField(Secret, 'id'),
  providers: byField(ProviderRecord, 'id'),
  modelCategories: byField(ModelCategory, 'id'),
  budgets: byField(BudgetRule, 'id'),
  priorityRules: byField(PriorityRule, 'id'),
  reservations: byField(Reservation, 'id'),
  ledger: byField(LedgerEntry, 'id'),
  notifications: byField(Notification, 'id'),
  pushSubscriptions: byField(PushSubscription, 'id'),
  // build 2
  instances: byFields(InstanceRecord, 'system', 'instance'),
  contextLinks: byFields(ContextLink, 'from', 'toKey', 'relation'),
  modelLimits: byField(ModelLimitsRecord, 'model'),
  modelCalibration: byField(ModelCalibration, 'model'),
  forms: byFields(FormRecord, 'hash', 'kind', 'converter'),
  modelCalls: byField(ModelCall, 'id'),
  modelRoles: {
    row: ModelRoleRecord, fields: ['choice.role'], rowKey: (record) => record.choice.role, key: (role) => role,
  } satisfies TableDef<typeof ModelRoleRecord, ModelRole>,
  fnMetrics: byFields(FnMetricsDay, 'fn', 'day'),
  mcps: byField(HubMcp, 'id'),
  // build 3
  autoPairSecrets: byField(AutoPairSecret, 'id'),
  hubOptions: byField(HubOption, 'key'),
} as const;

/** The table names. */
export type TableName = keyof typeof HUB_TABLES;

/** The row type of a table. */
export type RowOf<T extends TableName> = z.infer<(typeof HUB_TABLES)[T]['row']>;

/** The key a reader passes for a table's rows: the key field's value, or the parts of a composite key, by name. */
export type KeyOf<T extends TableName> = Parameters<(typeof HUB_TABLES)[T]['key']>[0];
