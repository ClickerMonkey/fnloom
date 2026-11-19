/**
 * The smallest shared shapes: JSON, ids, units, names and the enums every other contract uses. Each is a zod schema
 * first; its TypeScript type is derived from it with `z.infer`, so the schema is the one source of truth.
 */
import { z } from 'zod';

/** Whether two types are each other, both ways round; `true satisfies Same<A, B>` pins two lists of one fact together. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Any JSON value. */
export const Json = z.json();
export type Json = z.infer<typeof Json>;

/** A JSON object. */
export const JsonObject = z.record(z.string(), Json);
export type JsonObject = z.infer<typeof JsonObject>;

/**
 * A parsed value as JSON, with fields set to `undefined` left out as `JSON.stringify` leaves them (an optional field a
 * strict tool call sent as null arrives as `undefined`, which `Json` refuses).
 */
export function jsonOf(value: unknown): Json {
  return value === undefined ? null : Json.parse(JSON.parse(JSON.stringify(value)));
}

/** Whether a JSON value is an object (not null, not a list). */
export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  modelCall: 'mdl',
  mcp: 'mcp',
  autoPair: 'apk',
  connection: 'cnx',
  fnExample: 'fex',
  refusal: 'rfs',
  /** Build 8: a record of a stored type (the data system). */
  record: 'rec',
  /** Build 8: one `@` search the hub sent a system, which its resource search is tied to. */
  mentionRequest: 'mrq',
} as const;

/** The kinds of id. */
export type IdKind = keyof typeof ID_PREFIXES;

/**
 * A schema for an opaque id of one kind: its kind's prefix, an underscore, then at least one more character. Ids of
 * different kinds are branded differently, so a `RunId` can't be passed where a `TurnId` is wanted, and text from
 * outside (model-written args, URL params, form input) only parses as the kind its prefix names.
 */
export const id = <const K extends IdKind>(kind: K) =>
  z
    .string()
    .regex(new RegExp(`^${ID_PREFIXES[kind]}_.+$`), `expected a ${kind} id starting with "${ID_PREFIXES[kind]}_"`)
    .brand<K>()
    .describe(`${kind} id`);

/** The schema type of one kind's id. */
type IdSchema<K extends IdKind> = ReturnType<typeof id<K>>;

/** Whether a name is a kind of id. */
export const isIdKind = (name: string): name is IdKind => Object.hasOwn(ID_PREFIXES, name);

/** Build the id schema of every kind from `ID_PREFIXES`, so the kinds are listed once. */
function idSchemas(): { readonly [K in IdKind]: IdSchema<K> } {
  const schemas = Object.fromEntries(Object.keys(ID_PREFIXES).filter(isIdKind).map((kind) => [kind, id(kind)]));
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- one entry per key of ID_PREFIXES, each built by `id` from its own key
  return schemas as { readonly [K in IdKind]: IdSchema<K> };
}

/** A local name inside a system: letters, digits, `_`, `-` and `.` (methods are `Type.method`). */
export const LocalName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);

/** The id schemas by kind. */
export const IDS = idSchemas();

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
export const ModelCallId = IDS.modelCall;
export type ModelCallId = IdOf<'modelCall'>;
export const HubMcpId = IDS.mcp;
export type HubMcpId = IdOf<'mcp'>;
export const AutoPairId = IDS.autoPair;
export type AutoPairId = IdOf<'autoPair'>;
export const ConnectionId = IDS.connection;
export type ConnectionId = IdOf<'connection'>;

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

/** A fn's kind: `native` for a fn the system implements, else the qualified name of the kind that runs it. */
export const FnKindName = z.union([z.literal('native'), QualifiedName]);
export type FnKindName = z.infer<typeof FnKindName>;

/** Join a system and a local name. */
export function qualify<const S extends string, const N extends string>(system: S, local: N): QualifiedName<S, N> {
  return `${system}/${local}`;
}

/** Split a qualified name into its system and local name. */
export function splitName(name: QualifiedName): { system: string; local: string } {
  const at = name.indexOf('/');
  return { system: name.slice(0, at), local: name.slice(at + 1) };
}

/**
 * A fn's name as an LLM tool name. Providers allow only letters, digits, `_` and `-` (at most 64), so `/` becomes
 * `__` and `.` (methods) becomes `--`. The prompt keeps a map back to the fn; `fnOfToolName` reads one back for people
 * (an LLM call's tools) and for refusals.
 */
export function toolName(fn: QualifiedName): string {
  return fn.replaceAll('/', '__').replaceAll('.', '--').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * The fn a tool name means: the model's own `system/name`, else `toolName` undone, kept only when it encodes back to
 * the same tool name (a lossy name means none).
 */
export function fnOfToolName(name: string): QualifiedName | undefined {
  const given = QualifiedName.safeParse(name);
  if (given.success) { return given.data; }
  const guess = QualifiedName.safeParse(name.replaceAll('__', '/').replaceAll('--', '.'));
  return guess.success && toolName(guess.data) === name ? guess.data : undefined;
}

/** How urgent queued work is, most urgent first. */
export const PRIORITIES = ['urgent', 'interactive', 'normal', 'background'] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

/** Who can see a thing: people in the UI, the LLM, both, or neither. */
export const Audience = z.enum(['user', 'llm', 'both', 'none']);
export type Audience = z.infer<typeof Audience>;

/** What kind of thing an actor is. */
export const ActorKind = z.enum(['user', 'group', 'agent', 'system', 'mcp']);
export type ActorKind = z.infer<typeof ActorKind>;

/** A schema for a page of items with a cursor for the next page (absent on the last page). */
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), cursor: z.string().optional() });
/** A page of items; `cursor` is absent on the last page. */
export type Page<T> = z.infer<ReturnType<typeof page<z.ZodType<T>>>>;

/** A cursor-paged request. */
export const PageRequest = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() });
export type PageRequest = z.infer<typeof PageRequest>;

/** The message of anything thrown: an `Error`'s message, or the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The tag that marks a fn as only reading: with no policy that matches, it runs without asking. */
export const READ_TAG = 'read';

/**
 * The tag that marks a hub fn that only adds or changes what the calling system makes for a run (`hub/save_fn` keeps
 * a fn of the caller's own kind, `hub/resource_import` keeps a page or result it fetched as a new resource): with no
 * policy that matches, a system's call runs without asking, since it does what the person's run asked of that system.
 */
export const OWN_TAG = 'own';

/**
 * The tag that marks a fn as changing what others may reach (MCPs, policies, config, pairing, installs). Such a fn is
 * never exposed through a hub MCP, whatever its rules say.
 */
export const ADMIN_TAG = 'admin';

/**
 * System names the hub keeps for context it owns: memory (`memory/prefers-pnpm`) and context made from resources
 * (`resource/harness-md-decided-3f9a1c2e`). Pairing refuses them, so such a name can never collide with a real system.
 */
export const RESERVED_SYSTEM_NAMES = ['hub', 'memory', 'resource'] as const;
export type ReservedSystemName = (typeof RESERVED_SYSTEM_NAMES)[number];

/** Whether a name is one the hub keeps for itself. */
export function isReservedSystemName(name: string): name is ReservedSystemName {
  return RESERVED_SYSTEM_NAMES.some((reserved) => reserved === name);
}

/**
 * One attached copy of a system: a fleet of fs machines is one system `fs` with instances `laptop` and `desk`. A system
 * that runs one copy has the single instance `main`. Same shape as a system name.
 */
export const InstanceName = z.string().regex(SYSTEM_NAME_PATTERN).brand<'InstanceName'>();
export type InstanceName = z.infer<typeof InstanceName>;

/** The instance a system has when it runs one copy. */
export const MAIN_INSTANCE = InstanceName.parse('main');

/** One instance of one system, written `fs@laptop` in logs and the UI. */
export const InstanceRef = z.object({ system: SystemName, instance: InstanceName });
export type InstanceRef = z.infer<typeof InstanceRef>;

/** An instance ref as people read it: `fs@laptop`. */
export function instanceLabel(ref: InstanceRef): string {
  return `${ref.system}@${ref.instance}`;
}

/**
 * A qualified name or a glob over qualified names: `fs/read`, `fs/*`, `hub/search_*`. The one selector over names that
 * policies (`FnMatch.fn`) and hub MCP rules share; `globMatch` in the catalog is its one matcher.
 */
export const NameGlob = z.string().regex(/^[a-z*][a-z0-9*-]*\/[A-Za-z0-9_.*-]+$/).brand<'NameGlob'>();
export type NameGlob = z.infer<typeof NameGlob>;
