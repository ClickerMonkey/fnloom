/**
 * A system's contract on the wire: the manifest it sends on connect (skipped when the hash matches) and the patches
 * that keep it current. The SDK builds it from the typed contract (`manifestOf`), so the two can't disagree. Names
 * inside a manifest are local (unqualified); references to other things are qualified.
 */
import { z } from 'zod';
import { DeclaredLink } from './context-graph.ts';
import { GinTypeDef } from './gin.ts';
import { ActorKind, Audience, LocalName, Duration, Json, QualifiedName, SessionId, SystemName, TurnId, Usd } from './primitives.ts';
import { SectionMatch, Link } from './resources.ts';
import { Display, FnLimits, Operations, ProgressDecl, TimeInfo, UserInfo } from './run.ts';
import { StatusTemplates } from './status.ts';
import { ConnectDecl } from './connections.ts';
import { SystemProviderDecl } from './system-providers.ts';
import { FnValidation } from './validation.ts';


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
  /** The status words of its fns that declare none. */
  status: StatusTemplates.optional(),
});
export type KindDecl = z.infer<typeof KindDecl>;

export const HandlerDecl = z.object({ description: z.string(), args: GinTypeDef, returns: GinTypeDef, required: z.boolean() });
export type HandlerDecl = z.infer<typeof HandlerDecl>;

/** `native`, or the qualified name of the kind that runs a fn. */
export const FnKindName = z.union([z.literal('native'), QualifiedName]);
export type FnKindName = z.infer<typeof FnKindName>;

/** One example call of a fn: its args, and what the example shows. */
export const FnExample = z.object({ args: Json, note: z.string().optional() });
export type FnExample = z.infer<typeof FnExample>;

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
  /** What its runs say they are doing; its kind's, then the hub's defaults, when absent. */
  status: StatusTemplates.optional(),
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
  /**
   * Example calls, shown on the fn's card at `full` detail and in its invalid-input replies. The SDK checks each
   * example's args against the fn's own args type when the contract is built, so a wrong example does not build.
   */
  examples: z.array(FnExample).optional(),
  /** Build 4: the validation hooks its system runs before and after a run (`validate` on the system link). */
  validate: FnValidation.optional(),
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
  /** How much it counts when scored (0 leaves it out; 1 when absent). */
  weight: z.number().min(0).max(2).optional(),
  /** A short form shown at `signature` detail; its description when absent. */
  summary: z.string().optional(),
  /** Its parent in a hierarchy, and the next piece of a chain (a long text in ordered pieces). */
  parent: QualifiedName.optional(),
  next: QualifiedName.optional(),
  /** Weighted links to other context, fns, types and resources. */
  links: z.array(DeclaredLink).optional(),
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
  /** Build 4: aeye providers whose code runs in the system; the hub registers each as `<system>/<name>`. */
  providers: z.array(SystemProviderDecl).optional(),
  /** Build 4: a per-person system: each person connects their own account on its page. */
  connect: ConnectDecl.optional(),
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
  /** Status words for this payload's fn, when the kind can say better than its defaults. */
  status: StatusTemplates.optional(),
  limits: FnLimits.optional(),
  display: Display.optional(),
});
export type KindDescription = z.infer<typeof KindDescription>;

// ─── Hooks, mentions and events ───────────────────────────────────────────────

/** What a user-message hook sees. */
export const HookInput = z.object({ session: SessionId, turn: TurnId, text: z.string(), user: UserInfo, time: TimeInfo });
export type HookInput = z.infer<typeof HookInput>;

/** How well a suggestion matches the message, higher is better (the hub's index gives cosine similarity, 0 to 1). */
export const SuggestionScore = z.number();
export type SuggestionScore = z.infer<typeof SuggestionScore>;

/**
 * What a hook adds. Each becomes a tagged block the LLM can tell apart from the user's words. A suggestion's system is
 * its qualified name's; its kind is its block's. The hub lists its own suggestions best match first, with scores.
 */
export const HookBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), tag: z.string(), text: z.string() }),
  z.object({ type: z.literal('suggest-context'), items: z.array(z.object({ context: QualifiedName, why: z.string().optional(), score: SuggestionScore.optional() })) }),
  z.object({ type: z.literal('suggest-fns'), items: z.array(z.object({ fn: QualifiedName, why: z.string().optional(), score: SuggestionScore.optional() })) }),
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
