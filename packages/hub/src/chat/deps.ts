/**
 * What the chat module needs from the rest of the hub, as the other modules' interfaces. Each chat class takes only
 * the slice of these it uses (`Pick<ChatDeps, …>`), so its tests fake just that.
 */
import type { Logger } from '@ayepi/log';
import type { ActorId, ContentRef, IdRandom, ResourceUri, SessionId } from '@harness/core';
import type { PushService } from '../api/index.ts';
import type { HubSettings } from '../boot/env.ts';
import type { EventBus } from '../bus.ts';
import type { AccessService } from '../access/index.ts';
import type { Catalog } from '../catalog/index.ts';
import type { AgentLoop, LimitResolver, LlmGateway, RunService } from '../execution/index.ts';
import type { Search, Suggester } from '../index/index.ts';
import type { LinkService } from '../link/index.ts';
import type { Decider } from '../models/index.ts';
import type { HubStore } from '../store/index.ts';
import type { ChatEnv } from './env.ts';

/** The hub settings chat reads: its own slice, and the shared ones it follows. */
export interface ChatSettings {
  readonly chat: ChatEnv;
  readonly queue: Pick<HubSettings['queueEnv'], 'HARNESS_ACTIVE_WINDOW'>;
  readonly model: Pick<HubSettings['modelEnv'], 'HARNESS_SUGGESTIONS'>;
}

/** Everything chat uses, by the interface that provides it. */
export interface ChatDeps {
  readonly settings: ChatSettings;
  readonly log: Logger;
  readonly clock: () => number;
  /** The random part of new ids (tests pass a counter). */
  readonly random?: IdRandom;
  readonly bus: EventBus;
  readonly store: HubStore;
  readonly catalog: Catalog;
  readonly link: Pick<LinkService, 'connection' | 'connected' | 'onChange'>;
  readonly runs: RunService;
  readonly agents: Pick<AgentLoop, 'start' | 'interrupt' | 'continue'>;
  readonly limits: LimitResolver;
  readonly search: Search;
  readonly suggest: Suggester;
  /** The hub's own chat calls (suggestions picked by an LLM). */
  readonly llm: Pick<LlmGateway, 'chat'>;
  /** The hub's own decision calls (suggestions picked by a decision model), split by the model's `maxQuestions`. */
  readonly decider: Pick<Decider, 'model' | 'ask'>;
  readonly push: Pick<PushService, 'send'>;
  /** The hub's own actor: the author of notes the hub writes into a session. */
  readonly hubActor: ActorId;
  /** What each person may see and use. */
  readonly access: Pick<AccessService, 'scope'>;
  /**
   * The room, in tokens, the prompt for a message has besides its fixed part (the session's agent model's window less
   * its output, reasoning, margin, instructions, tools and the message itself: the contextor's flexible budget), so
   * context a suggestions chooser loads into the message is sized to it. Undefined when it can't be told (no agent, no
   * planner); then only `HARNESS_AUTOLOAD_TOKENS` holds it.
   */
  readonly promptRoom?: (input: { session: SessionId; text: string; actor: ActorId }) => Promise<number | undefined>;
  /**
   * Keeps a file the person attached as a hub resource (the resources module's import) and gives its uri, with its text
   * when it is a text file (at most `maxChars`), so the model reads it at once. Absent (some tests): files reach the
   * model by their content ref only.
   */
  readonly files?: AttachedFiles;
}

/** How a sent message's files become resources the model reads (`ChatDeps.files`). */
export interface AttachedFiles {
  keep(file: { readonly ref: ContentRef; readonly name: string }, who: { readonly actor: ActorId; readonly session: SessionId }, maxChars: number): Promise<{ uri: ResourceUri; text?: string; truncated?: boolean }>;
}
