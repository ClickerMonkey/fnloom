/**
 * A system's contract on the wire: the manifest it sends on connect (skipped when the hash matches) and the patches
 * that keep it current. The SDK builds it from the typed contract (`manifestOf`), so the two can't disagree. Names
 * inside a manifest are local (unqualified); references to other things are qualified.
 */
import { z } from 'zod';
import { GinTypeDef } from './gin.ts';
import { ActorKind, Audience, Duration, Json, MessageId, QualifiedName, RunId, SessionId, SystemName, Timestamp, TurnId, ActorId, Usd } from './primitives.ts';
import { ResourceChange, SectionMatch, Link } from './resources.ts';
import { Display, FnLimits, Operations, ProgressDecl, RunUpdate, TimeInfo, UserInfo } from './run.ts';

/** A local name inside a system: letters, digits, `_`, `-` and `.` (methods are `Type.method`). */
export const LocalName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);

/** How values of a named type are shown: in mention chips, hover cards and inputs. */
export const TypeDisplay = z.object({
  /** The type's name for people: "Customer". */
  label: z.string(),
  plural: z.string().optional(),
  /** An icon name or URL. */
  icon: z.string().optional(),
  /** A CSS color. */
  color: z.string().optional(),
  /** The field whose value names a value ("Acme Corp"). */
  title: z.string().optional(),
  /** The field shown under it. */
  subtitle: z.string().optional(),
});
export type TypeDisplay = z.infer<typeof TypeDisplay>;

/** A named type. Its methods are sent as fns named `Type.method` whose args hold the value as `self`. */
export const TypeDecl = z.object({
  name: LocalName,
  description: z.string(),
  def: GinTypeDef,
  display: TypeDisplay,
  methods: z.array(LocalName),
  /** The named types its definition refers to (gin `typeReferences`), so a receiver can load them first. */
  references: z.array(z.string()),
});
export type TypeDecl = z.infer<typeof TypeDecl>;

/** How a user's setting value combines with their groups'. */
export const SettingMerge = z.enum(['user-wins', 'union', 'intersect', 'most-restrictive']);
export type SettingMerge = z.infer<typeof SettingMerge>;

/** Besides admins, who may set a setting. */
export const SettingEditor = z.enum(['self', 'fns']);
export type SettingEditor = z.infer<typeof SettingEditor>;

export const SettingDecl = z.object({
  name: LocalName,
  description: z.string(),
  type: GinTypeDef,
  appliesTo: z.array(ActorKind),
  merge: SettingMerge,
  editableBy: z.array(SettingEditor),
});
export type SettingDecl = z.infer<typeof SettingDecl>;

export const AttachmentDecl = z.object({ name: LocalName, description: z.string(), data: GinTypeDef });
export type AttachmentDecl = z.infer<typeof AttachmentDecl>;

export const KindDecl = z.object({
  name: LocalName,
  description: z.string(),
  /** When an agent should pick this kind for a new fn. */
  applicability: z.string(),
  payload: GinTypeDef,
  /** Whether declaring or changing a fn of this kind at runtime needs approval. */
  approveChanges: z.boolean(),
});
export type KindDecl = z.infer<typeof KindDecl>;

export const HandlerDecl = z.object({ description: z.string(), args: GinTypeDef, returns: GinTypeDef, required: z.boolean() });
export type HandlerDecl = z.infer<typeof HandlerDecl>;

/** `native`, or the qualified name of the kind that runs a fn. */
export const FnKindName = z.union([z.literal('native'), QualifiedName]);
export type FnKindName = z.infer<typeof FnKindName>;

/**
 * A fn. Native fns carry their signature, deps and handlers as declared. Fns of other kinds carry a payload; the hub
 * asks the kind's system to describe it and checks the result against the declared signature.
 */
export const FnDecl = z.object({
  name: LocalName,
  description: z.string(),
  instructions: z.string().optional(),
  kind: FnKindName,
  payload: Json.optional(),
  args: GinTypeDef,
  returns: GinTypeDef,
  deps: z.array(QualifiedName),
  handlers: z.record(z.string(), HandlerDecl),
  progress: ProgressDecl,
  operations: Operations,
  undo: GinTypeDef.optional(),
  resume: GinTypeDef.optional(),
  /** The session state fields it uses (an object type). */
  state: GinTypeDef.optional(),
  /** What its renderer's form submits. */
  form: GinTypeDef.optional(),
  display: Display,
  limits: FnLimits,
  visibility: Audience,
  tags: z.array(z.string()),
});
export type FnDecl = z.infer<typeof FnDecl>;

/** One argument of a `/command`. */
export const CommandArg = z.object({ name: z.string(), hint: z.string(), required: z.boolean() });
export type CommandArg = z.infer<typeof CommandArg>;

export const ContextDecl = z.object({
  name: LocalName,
  description: z.string(),
  /** Absent for dynamic context: the hub asks the system for it on load. */
  content: z.string().optional(),
  command: z.object({ name: z.string(), args: z.array(CommandArg) }).optional(),
  imports: z.array(QualifiedName),
  fns: z.array(QualifiedName),
  suggestFns: z.array(QualifiedName),
  suggest: Audience,
  visible: Audience,
  alwaysFor: z.array(QualifiedName),
  tags: z.array(z.string()),
});
export type ContextDecl = z.infer<typeof ContextDecl>;

export const HookDecl = z.object({ name: LocalName, description: z.string(), order: z.number(), timeout: Duration });
export type HookDecl = z.infer<typeof HookDecl>;

export const MentionDecl = z.object({
  name: LocalName,
  title: z.string(),
  description: z.string(),
  target: GinTypeDef,
  /** The named type of the things it points at. */
  of: QualifiedName.optional(),
});
export type MentionDecl = z.infer<typeof MentionDecl>;

export const EmbedderDecl = z.object({
  name: LocalName,
  dimensions: z.number().int().min(1),
  /** Most characters per text. */
  maxInput: z.number().int().min(1),
  pricePerMillionTokens: Usd,
});
export type EmbedderDecl = z.infer<typeof EmbedderDecl>;

export const SectionerDecl = z.object({ name: LocalName, description: z.string(), match: SectionMatch });
export type SectionerDecl = z.infer<typeof SectionerDecl>;

export const ActionDecl = z.object({
  name: LocalName,
  description: z.string(),
  input: GinTypeDef,
  returns: GinTypeDef,
  state: GinTypeDef.optional(),
  expires: Duration.optional(),
});
export type ActionDecl = z.infer<typeof ActionDecl>;

/** The kinds of hub event a system can subscribe to. */
export const SYSTEM_EVENT_TYPES = ['message', 'run', 'resources', 'system', 'fns'] as const;
export const SystemEventType = z.enum(SYSTEM_EVENT_TYPES);
export type SystemEventType = z.infer<typeof SystemEventType>;

/** A system's built client renderers, uploaded to and served by the hub. */
export const ClientAssets = z.object({
  entry: z.string(),
  hash: z.string(),
  files: z.array(z.object({ path: z.string(), size: z.number().int().min(0), hash: z.string() })),
});
export type ClientAssets = z.infer<typeof ClientAssets>;

/** The sections of a manifest that a patch can change. */
export const MANIFEST_SECTION_NAMES = ['types', 'settings', 'attachments', 'kinds', 'fns', 'context', 'hooks', 'mentions', 'embedders', 'sectioners', 'actions'] as const;
export const ManifestSection = z.enum(MANIFEST_SECTION_NAMES);
export type ManifestSection = z.infer<typeof ManifestSection>;

/** The schema of one entry in each manifest section. */
export const MANIFEST_SECTIONS = {
  types: TypeDecl,
  settings: SettingDecl,
  attachments: AttachmentDecl,
  kinds: KindDecl,
  fns: FnDecl,
  context: ContextDecl,
  hooks: HookDecl,
  mentions: MentionDecl,
  embedders: EmbedderDecl,
  sectioners: SectionerDecl,
  actions: ActionDecl,
} as const satisfies Record<ManifestSection, z.ZodType>;

/** The declaration type of one manifest section. */
export type SectionDecl<S extends ManifestSection> = z.infer<(typeof MANIFEST_SECTIONS)[S]>;

const sections = {
  types: z.array(TypeDecl),
  settings: z.array(SettingDecl),
  attachments: z.array(AttachmentDecl),
  kinds: z.array(KindDecl),
  fns: z.array(FnDecl),
  context: z.array(ContextDecl),
  hooks: z.array(HookDecl),
  mentions: z.array(MentionDecl),
  embedders: z.array(EmbedderDecl),
  sectioners: z.array(SectionerDecl),
  actions: z.array(ActionDecl),
} as const satisfies { readonly [S in ManifestSection]: z.ZodArray<(typeof MANIFEST_SECTIONS)[S]> };

/** A system's whole contract as JSON. */
export const Manifest = z.object({
  name: SystemName,
  version: z.string(),
  description: z.string(),
  /** Hash of everything else; sent in `Hello`. */
  hash: z.string(),
  ...sections,
  /** Events it handles; the hub only sends those. */
  events: z.array(SystemEventType),
  /** Whether it serves resources. Roots are fetched separately (they can change). */
  resources: z.boolean(),
  client: ClientAssets.optional(),
  /** The type of its config. */
  config: GinTypeDef,
  /** Systems whose fns, kinds, types or context it refers to. */
  requires: z.array(SystemName),
});
export type Manifest = z.infer<typeof Manifest>;

/** A runtime change to a manifest: entries to add or replace, and names to remove, per section. */
export const ManifestPatch = z.object({
  hash: z.string(),
  upsert: z.object(sections).partial(),
  remove: z.partialRecord(ManifestSection, z.array(LocalName)),
});
export type ManifestPatch = z.infer<typeof ManifestPatch>;

/** What the hub did with a manifest or patch. */
export const ImportReport = z.object({
  added: z.array(QualifiedName),
  updated: z.array(QualifiedName),
  removed: z.array(QualifiedName),
  /** Refused, and why: a bad type, a name clash, an incompatible change to a fn others depend on. */
  refused: z.array(z.object({ name: z.string(), problems: z.array(z.string()) })),
});
export type ImportReport = z.infer<typeof ImportReport>;

/**
 * Everything a kind works out from one payload, so the author of a fn of that kind writes only the payload. The hub
 * stores this with the fn and recomputes it whenever the payload, or anything it references, changes.
 */
export const KindDescription = z.object({
  args: GinTypeDef,
  returns: GinTypeDef,
  /** The fns a payload calls. The hub refuses calls outside these. */
  deps: z.array(QualifiedName),
  /** The named types the payload references, so the hub can load them and re-describe when one changes. */
  types: z.array(QualifiedName).optional(),
  /** The resources or context the payload references. */
  refs: z.array(z.string()).optional(),
  operations: Operations,
  handlers: z.record(z.string(), HandlerDecl).optional(),
  progress: ProgressDecl.optional(),
  limits: FnLimits.optional(),
  display: Display.optional(),
});
export type KindDescription = z.infer<typeof KindDescription>;

// ─── Hooks, mentions and events ───────────────────────────────────────────────

/** What a user-message hook sees. */
export const HookInput = z.object({ session: SessionId, turn: TurnId, text: z.string(), user: UserInfo, time: TimeInfo });
export type HookInput = z.infer<typeof HookInput>;

/** What a hook adds. Each becomes a tagged block the LLM can tell apart from the user's words. */
export const HookBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), tag: z.string(), text: z.string() }),
  z.object({ type: z.literal('suggest-context'), items: z.array(z.object({ context: QualifiedName, why: z.string().optional() })) }),
  z.object({ type: z.literal('suggest-fns'), items: z.array(z.object({ fn: QualifiedName, why: z.string().optional() })) }),
  z.object({ type: z.literal('load'), context: z.array(QualifiedName).optional(), fns: z.array(QualifiedName).optional() }),
]);
export type HookBlock = z.infer<typeof HookBlock>;

/** One result in the `@` picker. `target` is the provider's own key for the thing. */
export const MentionOption = z.object({
  label: z.string(),
  hint: z.string().optional(),
  icon: z.string().optional(),
  target: Json,
});
export type MentionOption = z.infer<typeof MentionOption>;

/** What a person sees when hovering a mention. `value` is the thing as its declared type, so the card offers its methods. */
export const MentionHover = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  /** A short preview, in markdown. */
  body: z.string().optional(),
  /** Where clicking the chip goes. */
  open: Link.optional(),
  value: Json.optional(),
});
export type MentionHover = z.infer<typeof MentionHover>;

/** A message as systems see it. */
export const MessageView = z.object({
  id: MessageId,
  session: SessionId,
  author: ActorId,
  role: z.enum(['user', 'assistant', 'note']),
  text: z.string(),
  replyTo: MessageId.optional(),
  replyAll: z.boolean(),
  createdAt: Timestamp,
});
export type MessageView = z.infer<typeof MessageView>;

/** Hub events a system can subscribe to. */
export const SystemEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: MessageView }),
  z.object({ type: z.literal('run'), run: RunId, fn: QualifiedName, update: RunUpdate }),
  z.object({ type: z.literal('resources'), changes: z.array(ResourceChange) }),
  z.object({ type: z.literal('system'), system: SystemName, status: z.enum(['connected', 'disconnected', 'removed']) }),
  z.object({ type: z.literal('fns'), added: z.array(QualifiedName), removed: z.array(QualifiedName) }),
]);
export type SystemEvent = z.infer<typeof SystemEvent>;
