/**
 * The smallest shared shapes: JSON, ids, units, names and the enums every other contract uses. Each is a zod schema
 * first; its TypeScript type is derived from it with `z.infer`, so the schema is the one source of truth.
 */
import { z } from 'zod';

/** Any JSON value. */
export const Json = z.json();
export type Json = z.infer<typeof Json>;

/** A JSON object. */
export const JsonObject = z.record(z.string(), Json);
export type JsonObject = z.infer<typeof JsonObject>;

/**
 * A schema for an opaque id of one kind. Ids of different kinds are branded differently, so a `RunId` can't be
 * passed where a `TurnId` is wanted.
 */
export const id = <const K extends string>(kind: K) => z.string().min(1).brand<K>().describe(`${kind} id`);

/** Every kind of id the hub mints, with the prefix its ids start with. */
export const ID_PREFIXES = {
  run: 'run',
  turn: 'trn',
  session: 'ses',
  actor: 'act',
  message: 'msg',
  delivery: 'dlv',
  handlerCall: 'hcl',
  llmInteraction: 'llm',
  pairing: 'par',
  pairingToken: 'ptk',
  policy: 'pol',
  approval: 'apr',
  budget: 'bgt',
  priorityRule: 'pri',
  reservation: 'rsv',
  ledger: 'led',
  notification: 'ntf',
  push: 'psh',
  secret: 'sec',
  modelCategory: 'mct',
  provider: 'prv',
  sectionRule: 'srl',
  authSession: 'aus',
} as const;

/** The kinds of id. */
export type IdKind = keyof typeof ID_PREFIXES;

/** The id schemas by kind. */
export const IDS = {
  run: id('run'),
  turn: id('turn'),
  session: id('session'),
  actor: id('actor'),
  message: id('message'),
  delivery: id('delivery'),
  handlerCall: id('handlerCall'),
  llmInteraction: id('llmInteraction'),
  pairing: id('pairing'),
  pairingToken: id('pairingToken'),
  policy: id('policy'),
  approval: id('approval'),
  budget: id('budget'),
  priorityRule: id('priorityRule'),
  reservation: id('reservation'),
  ledger: id('ledger'),
  notification: id('notification'),
  push: id('push'),
  secret: id('secret'),
  modelCategory: id('modelCategory'),
  provider: id('provider'),
  sectionRule: id('sectionRule'),
  authSession: id('authSession'),
} as const satisfies Record<IdKind, z.ZodType<string>>;

/** The branded id type of a kind. */
export type IdOf<K extends IdKind> = z.infer<(typeof IDS)[K]>;

export const RunId = IDS.run;
export type RunId = IdOf<'run'>;
export const TurnId = IDS.turn;
export type TurnId = IdOf<'turn'>;
export const SessionId = IDS.session;
export type SessionId = IdOf<'session'>;
export const ActorId = IDS.actor;
export type ActorId = IdOf<'actor'>;
export const MessageId = IDS.message;
export type MessageId = IdOf<'message'>;
export const DeliveryId = IDS.delivery;
export type DeliveryId = IdOf<'delivery'>;
export const HandlerCallId = IDS.handlerCall;
export type HandlerCallId = IdOf<'handlerCall'>;
export const LlmInteractionId = IDS.llmInteraction;
export type LlmInteractionId = IdOf<'llmInteraction'>;
export const PairingId = IDS.pairing;
export type PairingId = IdOf<'pairing'>;
export const PairingTokenId = IDS.pairingToken;
export type PairingTokenId = IdOf<'pairingToken'>;
export const PolicyId = IDS.policy;
export type PolicyId = IdOf<'policy'>;
export const ApprovalId = IDS.approval;
export type ApprovalId = IdOf<'approval'>;
export const BudgetId = IDS.budget;
export type BudgetId = IdOf<'budget'>;
export const PriorityRuleId = IDS.priorityRule;
export type PriorityRuleId = IdOf<'priorityRule'>;
export const ReservationId = IDS.reservation;
export type ReservationId = IdOf<'reservation'>;
export const LedgerId = IDS.ledger;
export type LedgerId = IdOf<'ledger'>;
export const NotificationId = IDS.notification;
export type NotificationId = IdOf<'notification'>;
export const PushId = IDS.push;
export type PushId = IdOf<'push'>;
export const SecretId = IDS.secret;
export type SecretId = IdOf<'secret'>;
export const ModelCategoryId = IDS.modelCategory;
export type ModelCategoryId = IdOf<'modelCategory'>;
export const ProviderId = IDS.provider;
export type ProviderId = IdOf<'provider'>;
export const SectionRuleId = IDS.sectionRule;
export type SectionRuleId = IdOf<'sectionRule'>;
export const AuthSessionId = IDS.authSession;
export type AuthSessionId = IdOf<'authSession'>;

/** Makes the random part of a new id. Injectable, so tests get stable ids. */
export type IdRandom = () => string;

/** The default random part: 20 base-36 characters from the platform's secure random source. */
export const secureRandom: IdRandom = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => (b % 36).toString(36)).join('');

/** Make a new id of a kind: its prefix, an underscore, then the random part. */
export function mintId<K extends IdKind>(kind: K, random: IdRandom = secureRandom): IdOf<K> {
  return IDS[kind].parse(`${ID_PREFIXES[kind]}_${random()}`);
}

/** Milliseconds. */
export const Duration = z.number().int().min(0);
export type Duration = z.infer<typeof Duration>;
/** Milliseconds since the epoch. */
export const Timestamp = z.number().int();
export type Timestamp = z.infer<typeof Timestamp>;
/** US dollars. */
export const Usd = z.number();
export type Usd = z.infer<typeof Usd>;

/** The shape of a system name: lowercase letters, digits and dashes, starting with a letter. */
export const SYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** A system's name. Unique among the hub's systems; it namespaces everything the system contributes. */
export const SystemName = z.string().regex(SYSTEM_NAME_PATTERN).brand<'SystemName'>();
export type SystemName = z.infer<typeof SystemName>;

/** A name qualified by its system: `fs/read`, `hub/search_fns`, `fs/Entry`, `fs/Entry.reveal`. */
export const QualifiedName = z.templateLiteral([z.string().regex(SYSTEM_NAME_PATTERN), '/', z.string().min(1)]);
/** A name qualified by its system. The parameters narrow it to one system or one local name. */
export type QualifiedName<S extends string = string, N extends string = string> = `${S}/${N}`;

/** Join a system and a local name. */
export function qualify<const S extends string, const N extends string>(system: S, local: N): QualifiedName<S, N> {
  return `${system}/${local}`;
}

/** Split a qualified name into its system and local name. */
export function splitName(name: QualifiedName): { system: string; local: string } {
  const at = name.indexOf('/');
  return { system: name.slice(0, at), local: name.slice(at + 1) };
}

/** How urgent queued work is, most urgent first. */
export const PRIORITIES = ['urgent', 'interactive', 'normal', 'background'] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

/** Who can see a thing: people in the UI, the LLM, both, or neither. */
export const Audience = z.enum(['user', 'llm', 'both', 'none']);
export type Audience = z.infer<typeof Audience>;

/** What kind of thing an actor is. */
export const ActorKind = z.enum(['user', 'group', 'agent', 'system']);
export type ActorKind = z.infer<typeof ActorKind>;

/** A schema for a page of items with a cursor for the next page (absent on the last page). */
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), cursor: z.string().optional() });
/** A page of items. */
export interface Page<T> {
  items: T[];
  /** Absent on the last page. */
  cursor?: string | undefined;
}

/** A cursor-paged request. */
export const PageRequest = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() });
export type PageRequest = z.infer<typeof PageRequest>;
