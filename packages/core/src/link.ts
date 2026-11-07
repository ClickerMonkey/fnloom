/**
 * The system link: how the hub and a system talk over the system's one WebSocket. Both directions are plain ayepi
 * request and response. `hubLinkSpec` is what a system calls on the hub; `systemLinkSpec` is what the hub calls on a
 * system (ayepi peers). Every endpoint has a short explicit `ws` id so frames stay small. Large content never rides
 * in a frame: it moves as a `ContentRef` fetched in chunks.
 */
import { ctx, endpoint, middleware, spec, use } from '@ayepi/core';
import { telemetry } from '@ayepi/otel';
import { z } from 'zod';
import { LlmForward, LlmForwardChunk } from './llm.ts';
import { HookBlock, HookInput, ImportReport, KindDescription, Manifest, ManifestPatch, MentionHover, MentionOption, SystemEvent } from './manifest.ts';
import {
  ActorId, DeliveryId, Duration, HandlerCallId, Json, JsonObject, PairingId, QualifiedName, RunId, SessionId, SystemName, Timestamp, Usd, page,
} from './primitives.ts';
import { TypeRecord } from './records/systems.ts';
import { ContentRef, Link, ReadWant, ResourceChange, ResourceRead, ResourceRoot, ResourceStat, ResourceUri, Section } from './resources.ts';
import {
  AllowedOperations, BudgetLeft, HandlerAnswer, OutcomeWire, ProgressReport, RunInfo, RunSettled, RunUpdate, TimeInfo, UndoOutcome, UserInfo,
} from './run.ts';

// ─── Handshake ────────────────────────────────────────────────────────────────

/** The version of this protocol. */
export const LINK_PROTOCOL = 1;

/** The first call from a system. A new name starts pairing; a known name gets a challenge. */
export const Hello = z.object({
  protocol: z.literal(LINK_PROTOCOL),
  name: SystemName,
  version: z.string(),
  /** New per process start, to tell a restart from a reconnect. */
  instance: z.string(),
  /** The system's public key (Ed25519, SPKI DER as base64). */
  publicKey: z.string(),
  manifestHash: z.string(),
  pairingToken: z.string().optional(),
});
export type Hello = z.infer<typeof Hello>;

/** The hub's answer to `hello`: sign this nonce, or wait for an admin to approve the pairing. */
export const HelloReply = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('challenge'), nonce: z.string() }),
  z.object({
    kind: z.literal('pairing'),
    pairing: PairingId,
    /** Shown by the system so the admin can compare it (absent when a token is being checked). */
    code: z.string().optional(),
    /** Where the admin approves it. */
    url: z.string(),
    expiresAt: Timestamp,
  }),
]);
export type HelloReply = z.infer<typeof HelloReply>;

/** The system's signature over the challenge nonce. */
export const ChallengeAnswer = z.object({ signature: z.string() });
export type ChallengeAnswer = z.infer<typeof ChallengeAnswer>;

/** Size limits that keep system traffic small. */
export const LinkLimits = z.object({
  /** Largest frame; bigger content goes as a `ContentRef`. */
  maxFrame: z.number().int().min(1024),
  maxChunk: z.number().int().min(1024),
  heartbeat: Duration,
});
export type LinkLimits = z.infer<typeof LinkLimits>;

/** A system's config value as the hub holds it. */
export const ConfigValue = z.object({ value: Json, version: z.number().int().min(1) });
export type ConfigValue = z.infer<typeof ConfigValue>;

/** The hub accepts the system. */
export const Welcome = z.object({
  /** The system's config, if a valid one is set. Without one the system waits, unusable. */
  config: ConfigValue.optional(),
  /** Why it is starting, so the SDK runs the right lifecycle events. */
  start: z.object({ first: z.boolean(), upgradedFrom: z.string().optional() }),
  /** A short-lived token for HTTP (asset upload, presigned content). */
  token: z.string(),
  /** The hub's copy is stale: send the manifest. */
  sendManifest: z.boolean(),
  limits: LinkLimits,
});
export type Welcome = z.infer<typeof Welcome>;

/** Who is on the other end of a link connection, once the handshake is done. */
export const LinkSession = z.object({ system: SystemName, instance: z.string() });
export type LinkSession = z.infer<typeof LinkSession>;

/**
 * The link's session guard. Every hub link endpoint except the handshake requires it; its impl (in the hub's link
 * module) refuses a connection that hasn't finished the handshake and provides `link` to handlers.
 */
export const linkSession = middleware('linkSession', { provides: ctx<{ link: LinkSession }>() });

/**
 * Request telemetry on the system link (`@ayepi/otel`): every call a system makes on the hub gets a request id, trace
 * context for the logs inside it, and request and response lines. The hub binds it on the link server.
 */
export const linkTel = telemetry({ name: 'linkTel' });

// ─── Running ──────────────────────────────────────────────────────────────────

/** What a resuming run gets back: its resume state and the results of calls that already finished, by key. */
export const ResumeWire = z.object({
  state: Json,
  calls: z.record(z.string(), RunSettled),
  reason: z.enum(['resumed', 'restart']),
});
export type ResumeWire = z.infer<typeof ResumeWire>;

/** The hub's request to run a fn. */
export const RunRequest = z.object({
  /** Who and when: the person, their current time, this system and the caller. */
  run: RunInfo,
  /** The fn's local name (`read`, `Entry.reveal`). */
  fn: z.string(),
  /** `native`, or the qualified kind that runs it. */
  kind: z.union([z.literal('native'), QualifiedName]),
  payload: Json.optional(),
  args: Json,
  budget: BudgetLeft,
  /** The optional handlers the caller can answer. */
  handlers: z.array(z.string()),
  resume: ResumeWire.optional(),
  deadline: Timestamp,
  /** The config version to run with. The system already has the value, so requests stay small. */
  configVersion: z.number().int().min(0),
});
export type RunRequest = z.infer<typeof RunRequest>;

/** A run's session state, or an action's: who is asking decides which declared fields are visible. */
export const StateOwner = z.union([z.object({ run: RunId }), z.object({ delivery: DeliveryId })]);
export type StateOwner = z.infer<typeof StateOwner>;

/**
 * Who is asking, for requests a person causes (mentions, actions, dynamic context): their session, their actor, and
 * the same who-and-when a run gets, so a system never guesses at the person or their "today".
 */
export const Asker = z.object({ session: SessionId, actor: ActorId, user: UserInfo, time: TimeInfo });
export type Asker = z.infer<typeof Asker>;

/** A log line forwarded from a system. */
export const LogLine = z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), key: z.string(), fields: JsonObject });
export type LogLine = z.infer<typeof LogLine>;

/** Cancel or pause a run. The hub sends it to the system running the run; a system sends it for its own child calls. */
export const RunControl = z.object({ run: RunId, action: z.enum(['cancel', 'pause']) });
export type RunControl = z.infer<typeof RunControl>;

/** Whether a cancel or pause was taken up, and why not. */
export const ControlReply = z.object({ accepted: z.boolean(), reason: z.string().optional() });
export type ControlReply = z.infer<typeof ControlReply>;

/** Why a system is told to stop. */
export const StopReason = z.enum(['restart', 'upgrade', 'shutdown', 'removed']);
export type StopReason = z.infer<typeof StopReason>;

// ─── What a system calls on the hub ──────────────────────────────────────────

const linked = use(linkTel, linkSession).group({
  manifest: { body: Manifest, response: ImportReport, ws: 'mf' },
  patch: { body: ManifestPatch, response: ImportReport, ws: 'mp' },
  /** A call from inside a run. Queued like every run; replies when it settles (or goes to the background). */
  call: {
    body: z.object({
      parent: RunId,
      fn: QualifiedName,
      args: Json,
      key: z.string(),
      budget: z.object({ cost: Usd.optional(), time: Duration.optional() }).optional(),
      /** The optional handlers this caller supplies; the hub relays them back over `handler`. */
      handlers: z.array(z.string()),
      background: z.boolean(),
    }),
    response: RunSettled,
    ws: 'call',
  },
  /** A run calls one of its caller's handlers (`ctx.handlers.confirm(...)`). The hub relays it to whoever answers. */
  handle: { body: z.object({ run: RunId, handler: z.string(), args: Json }), response: HandlerAnswer, ws: 'ha' },
  /** Cancel or pause a child run this system called (`FnCall.cancel()` / `pause()`). */
  control: { body: RunControl, response: ControlReply, ws: 'cl' },
  progress: { body: z.object({ run: RunId, progress: ProgressReport }), ws: 'pg' },
  allow: { body: z.object({ run: RunId, operations: AllowedOperations.partial() }), ws: 'al' },
  undoWith: { body: z.object({ run: RunId, undo: Json }), ws: 'uw' },
  /** Attach to the run's assistant message: a system attachment (its data checked by the hub too) or a link. */
  attach: {
    body: z.object({
      run: RunId,
      item: z.union([z.object({ attachment: QualifiedName, data: Json, title: z.string() }), z.object({ link: Link })]),
    }),
    ws: 'at',
  },
  /**
   * Named type definitions another system declared, with every named type they reference (dependencies first), so a
   * system can load and use them. Names the hub doesn't know come back in `missing`.
   */
  types: { body: z.object({ names: z.array(QualifiedName).min(1) }), response: z.object({ types: z.array(TypeRecord), missing: z.array(z.string()) }), ws: 'ty' },
  resourcesChanged: { body: z.object({ changes: z.array(ResourceChange) }), ws: 'rc' },
  /** The LLM forward behind `ctx.llm` and the aeye provider systems use. */
  llm: { body: LlmForward, streamOut: LlmForwardChunk, ws: 'llm' },
  embed: { body: z.object({ texts: z.array(z.string()), run: RunId.optional() }), response: z.object({ vectors: z.array(z.array(z.number())), cost: Usd }), ws: 'em' },
  /** Resource access for `ctx.resources`, routed to whichever system serves the URI. */
  resource: { body: z.object({ uri: ResourceUri, want: z.array(ReadWant), run: RunId.optional() }), response: ResourceRead, ws: 'rs' },
  content: { body: z.object({ ref: ContentRef, offset: z.number().int().min(0), length: z.number().int().min(1) }), response: z.object({ chunk: z.string() }), ws: 'ct' },
  /** Upload content (base64 chunks); the last chunk returns the ref. */
  upload: { body: z.object({ upload: z.string(), chunk: z.string(), last: z.boolean(), mime: z.string() }), response: z.object({ ref: ContentRef.optional() }), ws: 'up' },
  setting: { body: z.object({ run: RunId, setting: QualifiedName }), response: z.object({ value: Json.optional() }), ws: 'st' },
  /** Session state: the hub reads and writes only the fields the fn or action declared, matched by name and type. */
  stateGet: { body: z.object({ owner: StateOwner }), response: z.object({ values: JsonObject, version: z.number().int() }), ws: 'sg' },
  /** Refused with `conflict` if another write came in after `version` (the SDK retries). */
  stateSet: {
    body: z.object({ owner: StateOwner, patch: JsonObject, clear: z.array(z.string()), version: z.number().int().optional() }),
    response: z.union([z.object({ version: z.number().int() }), z.object({ conflict: z.literal(true) })]),
    ws: 'ss',
  },
  log: { body: LogLine, ws: 'lg' },
});

/** What a system calls on the hub. */
export const hubLinkSpec = spec({
  endpoints: {
    ...use(linkTel).group({
      hello: { body: Hello, response: HelloReply, ws: 'hi' },
      prove: { body: ChallengeAnswer, response: Welcome, ws: 'pr' },
    }),
    ...linked,
  },
});
export type HubLinkSpec = typeof hubLinkSpec;

// ─── What the hub calls on a system ──────────────────────────────────────────

/** What the hub calls on a system, served by the system over its own connection. */
export const systemLinkSpec = spec({
  endpoints: {
    /** The pairing was approved: say hello again to get a challenge. */
    paired: endpoint({ body: z.object({ pairing: PairingId }), ws: 'pd' }),
    run: endpoint({ body: RunRequest, response: OutcomeWire, ws: 'run' }),
    control: endpoint({ body: RunControl, response: ControlReply, ws: 'ctl' }),
    /**
     * Undo a finished run with the undo payload it registered. `run` is the run as it ran (who it was for); a fn of a
     * kind also carries its kind and the fn's payload, since the kind's system undoes it.
     */
    undo: endpoint({
      body: z.object({ run: RunInfo, fn: z.string(), kind: z.union([z.literal('native'), QualifiedName]), fnPayload: Json.optional(), payload: Json }),
      response: UndoOutcome,
      ws: 'un',
    }),
    /**
     * Relay a handler call to the system whose run supplied the handler. `run` is that (calling) run and `key` the
     * call key it made the call under, so concurrent calls supplying the same handler stay apart.
     */
    handler: endpoint({ body: z.object({ call: HandlerCallId, run: RunId, key: z.string(), handler: z.string(), args: Json }), response: HandlerAnswer, ws: 'hd' }),
    /**
     * About a child call this system made: the hub created its run (`update` absent), or the run changed. Lets
     * `FnCall.run` resolve as soon as the child exists and `FnCall.watch` follow it.
     */
    child: endpoint({ body: z.object({ parent: RunId, key: z.string(), run: RunId, update: RunUpdate.optional() }), ws: 'ch' }),
    check: endpoint({ body: z.object({ kind: z.string(), payload: Json }), response: z.object({ problems: z.array(z.string()), description: KindDescription.optional() }), ws: 'ck' }),
    /** Dynamic context for a `/command` or a load. `session` is absent for a load outside a session. */
    context: endpoint({ body: Asker.partial({ session: true }).extend({ name: z.string(), args: z.record(z.string(), z.string()) }), response: z.object({ text: z.string() }), ws: 'cx' }),
    roots: endpoint({ response: z.array(ResourceRoot), ws: 'ro' }),
    list: endpoint({ body: z.object({ uri: ResourceUri, cursor: z.string().optional() }), response: page(ResourceStat), ws: 'ls' }),
    stat: endpoint({ body: z.object({ uri: ResourceUri }), response: z.object({ stat: ResourceStat.optional() }), ws: 'sa' }),
    read: endpoint({ body: z.object({ uri: ResourceUri, want: z.array(ReadWant) }), response: ResourceRead, ws: 'rd' }),
    sections: endpoint({ body: z.object({ sectioner: z.string(), uri: ResourceUri, version: z.string() }), response: z.array(Section), ws: 'sc' }),
    watch: endpoint({ body: z.object({ uris: z.array(ResourceUri), on: z.boolean() }), ws: 'wa' }),
    content: endpoint({ body: z.object({ ref: ContentRef, offset: z.number().int().min(0), length: z.number().int().min(1) }), response: z.object({ chunk: z.string() }), ws: 'ct' }),
    embed: endpoint({ body: z.object({ embedder: z.string(), texts: z.array(z.string()) }), response: z.object({ vectors: z.array(z.array(z.number())) }), ws: 'em' }),
    hook: endpoint({ body: z.object({ hook: z.string(), message: HookInput }), response: z.array(HookBlock), ws: 'hk' }),
    /** `@` search. */
    mentions: endpoint({ body: Asker.extend({ provider: z.string(), query: z.string() }), response: z.array(MentionOption), ws: 'mn' }),
    /** A mention's hover card, asked for when a person hovers it. */
    mentionHover: endpoint({ body: Asker.extend({ provider: z.string(), target: Json }), response: z.object({ hover: MentionHover.optional() }), ws: 'mh' }),
    /** A mention's text for the LLM, asked for when the message is sent. */
    mentionText: endpoint({ body: Asker.extend({ provider: z.string(), target: Json }), response: z.object({ text: z.string() }), ws: 'mt' }),
    event: endpoint({ body: SystemEvent, ws: 'ev' }),
    /** Deliver a stored action. Replies with the result; the hub keeps it with the delivery. */
    action: endpoint({ body: Asker.extend({ delivery: DeliveryId, action: z.string(), input: Json, run: RunId.optional() }), response: z.object({ result: Json }), ws: 'ac' }),
    /** Deliver a form submission to the run waiting in `ctx.form()`. */
    form: endpoint({ body: z.object({ delivery: DeliveryId, run: RunId, value: Json }), ws: 'fm' }),
    restart: endpoint({ body: z.object({ reason: z.string() }), ws: 'rt' }),
    /** Stop for a reason; the system runs `lifecycle.stopping` first, within `timeout`. */
    stop: endpoint({ body: z.object({ reason: StopReason, timeout: Duration }), ws: 'sp' }),
    /** The config changed (or was set for the first time). The system runs `lifecycle.configured`. */
    configure: endpoint({ body: ConfigValue.extend({ previous: Json.optional() }), ws: 'cf' }),
  },
});
export type SystemLinkSpec = typeof systemLinkSpec;
