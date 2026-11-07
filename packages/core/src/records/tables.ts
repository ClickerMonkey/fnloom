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
import { ContextRecord, FnRecord, KindRecord, PairingRequest, PairingToken, SystemRecord, TypeRecord } from './systems.ts';
import { Section } from '../resources.ts';
import { ResourceUri } from '../resources.ts';

/** A stored section: a resource's section at one version, with the hash of its text. */
export const SectionRow = Section.extend({ uri: ResourceUri, version: z.string(), hash: z.string() });
export type SectionRow = z.infer<typeof SectionRow>;

/** One table: its row schema and how a row's key is made from the row. */
export interface TableDef<S extends z.ZodType> {
  readonly row: S;
  /** The row's primary key, as one string (composite keys are joined with `\u0000`). */
  readonly key: (row: z.infer<S>) => string;
}

const table = <S extends z.ZodType>(row: S, key: (row: z.infer<S>) => string): TableDef<S> => ({ row, key });
const join = (...parts: string[]): string => parts.join('\u0000');

/** Every table, by name. */
export const HUB_TABLES = {
  actors: table(Actor, (r) => r.id),
  memberships: table(Membership, (r) => join(r.group, r.user)),
  credentials: table(Credential, (r) => join(r.user, r.kind)),
  authSessions: table(AuthSession, (r) => r.id),
  actorSettings: table(ActorSetting, (r) => join(r.setting, r.actor)),
  policies: table(Policy, (r) => r.id),
  approvals: table(Approval, (r) => r.id),
  systems: table(SystemRecord, (r) => r.name),
  pairings: table(PairingRequest, (r) => r.id),
  pairingTokens: table(PairingToken, (r) => r.id),
  types: table(TypeRecord, (r) => r.name),
  kinds: table(KindRecord, (r) => r.name),
  fns: table(FnRecord, (r) => r.name),
  context: table(ContextRecord, (r) => r.name),
  sessions: table(Session, (r) => r.id),
  messages: table(ChatMessage, (r) => r.id),
  turns: table(Turn, (r) => r.id),
  runs: table(Run, (r) => r.id),
  handlerCalls: table(HandlerCall, (r) => r.id),
  stateFields: table(StateField, (r) => join(r.session, r.system, r.name, r.type)),
  deliveries: table(DeliveryRecord, (r) => r.id),
  llmInteractions: table(LlmInteraction, (r) => r.id),
  resources: table(ResourceRecord, (r) => r.uri),
  sections: table(SectionRow, (r) => join(r.uri, r.version, r.key)),
  sectionRules: table(SectionRule, (r) => r.id),
  index: table(IndexEntry, (r) => join(r.embedder, r.kind, r.key)),
  secrets: table(Secret, (r) => r.id),
  providers: table(ProviderRecord, (r) => r.id),
  modelCategories: table(ModelCategory, (r) => r.id),
  budgets: table(BudgetRule, (r) => r.id),
  priorityRules: table(PriorityRule, (r) => r.id),
  reservations: table(Reservation, (r) => r.id),
  ledger: table(LedgerEntry, (r) => r.id),
  notifications: table(Notification, (r) => r.id),
  pushSubscriptions: table(PushSubscription, (r) => r.id),
} as const;

/** The table names. */
export type TableName = keyof typeof HUB_TABLES;

/** The row type of a table. */
export type RowOf<T extends TableName> = z.infer<(typeof HUB_TABLES)[T]['row']>;

/** Make the composite key of a table from its parts, in the order its `key` joins them. */
export const compositeKey = join;
