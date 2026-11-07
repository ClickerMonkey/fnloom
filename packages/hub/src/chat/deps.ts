/**
 * What the chat module needs from the rest of the hub, as the other modules' interfaces. Each chat class takes only
 * the slice of these it uses (`Pick<ChatDeps, …>`), so its tests fake just that.
 */
import type { Logger } from '@ayepi/log';
import type { ActorId, IdRandom } from '@harness/core';
import type { PushService } from '../api/index.ts';
import type { HubSettings } from '../boot/env.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import type { AgentLoop, LimitResolver, RunService } from '../execution/index.ts';
import type { Search, Suggester } from '../index/index.ts';
import type { LinkService } from '../link/index.ts';
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
  readonly agents: Pick<AgentLoop, 'start' | 'interrupt'>;
  readonly limits: LimitResolver;
  readonly search: Search;
  readonly suggest: Suggester;
  readonly push: Pick<PushService, 'send'>;
  /** The hub's own actor: the author of notes the hub writes into a session. */
  readonly hubActor: ActorId;
}
