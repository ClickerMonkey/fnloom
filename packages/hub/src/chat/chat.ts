/** Builds the chat module from what it needs, wiring its parts to each other once. */
import type { ChatDeps } from './deps.ts';
import { LinkDeliveryService } from './deliveries.ts';
import { HubMessageEnricher } from './enrich.ts';
import { HubSuggestions } from './suggestions.ts';
import type {
  ApproverDirectory, DeliveryService, MentionService, MessageEnricher, NotificationService, PresenceTracker, ReplyRule, SessionService, StateService, SuggestionDecider, TurnService,
  UndoService,
} from './index.ts';
import { ChatMentions, HubMentions, LinkedMentions } from './mentions.ts';
import { StoreMentionRequests, type MentionRequests } from './mention-requests.ts';
import { StoreApprovers, StoreNotifications } from './notifications.ts';
import { People } from './people.ts';
import { MemoryPresence } from './presence.ts';
import { SessionReplyRule } from './reply.ts';
import { StoreSessionService } from './sessions.ts';
import { TableStateService } from './state.ts';
import { StreamBuffer } from './streams.ts';
import { monotonic } from './support.ts';
import { StoreTurnService } from './turns.ts';
import { RunUndoService } from './undo.ts';
import { StoreCompareService } from './compare.ts';

/** The chat module's services. The first seven are `HubServices['chat']`; the rest are what the web API and execution also use. */
export interface ChatModule {
  readonly sessions: SessionService;
  readonly turns: TurnService;
  readonly reply: ReplyRule;
  readonly enrich: MessageEnricher;
  readonly suggestions: SuggestionDecider;
  readonly state: StateService;
  readonly deliveries: DeliveryService;
  readonly undo: UndoService;
  readonly mentions: MentionService;
  /** Build 8: the `@` searches sent to systems, which their resource searches are tied to. */
  readonly mentionRequests: MentionRequests;
  readonly notifications: NotificationService;
  readonly approvers: ApproverDirectory;
  readonly presence: PresenceTracker;
  /** A/B compare: a message answered by several variants of the chat's settings, one chosen. */
  readonly compare: StoreCompareService;
  /** Start listening: deliveries flush as systems connect, and hub events become notifications. Returns the stop. */
  start(): () => void;
}

/** Make the chat module. Its clock never repeats a reading, so what it creates sorts in the order it was made. */
export function createChat(given: ChatDeps): ChatModule {
  const deps: ChatDeps = { ...given, clock: monotonic(given.clock) };
  const people = new People(deps);
  // Presence measures real elapsed time, so it reads the plain clock.
  const presence = new MemoryPresence(given);
  const streams = new StreamBuffer();
  const sessions = new StoreSessionService(deps, people, presence, streams);
  const reply = new SessionReplyRule();
  const suggestions = new HubSuggestions(deps);
  const enrich = new HubMessageEnricher(deps, suggestions);
  const mentionRequests = new StoreMentionRequests({ keys: () => deps.store.ports.work.store, ttl: deps.settings.chat.HARNESS_MENTION_REQUEST_TTL, ...(deps.random === undefined ? {} : { random: deps.random }) });
  const mentions = new ChatMentions(deps, people, [new HubMentions(deps), new LinkedMentions(deps, mentionRequests)]);
  const notifications = new StoreNotifications(deps, presence);
  const state = new TableStateService(deps);
  const deliveries = new LinkDeliveryService(deps, people);
  const compare = new StoreCompareService(deps, { sessions, people, streams });
  const turns = new StoreTurnService(deps, { sessions, people, mentions, enricher: enrich, reply, notifications, presence, streams, compare });
  const undo = new RunUndoService(deps, sessions, state, compare);
  return {
    sessions, turns, reply, enrich, suggestions, state, deliveries, undo, mentions, mentionRequests, notifications, presence, compare, approvers: new StoreApprovers(deps),
    start: () => {
      const stops = [deliveries.start(), notifications.start(), sessions.follow()];
      return () => { for (const stop of stops) { stop(); } };
    },
  };
}
