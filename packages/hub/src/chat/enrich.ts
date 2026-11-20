/**
 * What is added to a user message before the LLM sees it, and the text the LLM gets for a message. The hub adds the
 * person's local time and the fns and context the message's embedding suggests; then each hook of the session's
 * systems adds its own blocks, in hook order. Every addition is a tagged block, so the model tells it from the
 * person's words. Suggestions are cards in the one XML of `contextor/xml.ts`, each fn's card snapshotted when the
 * message is sent, and a fn or context is suggested once in a chat, never again (`Session.suggested`). Before all of
 * that, a message after the first says which systems went on or off since the model was last told (`chat/announce.ts`).
 */
import {
  compact, DEFAULT_CHAT_MODE, type AnnouncedSystems, fnLabel, INPUT_ANSWER_TAG, splitName, type ActorId, type ChatMessage, type ChatModeType, type HookBlock, type HookInput, type Link, type MessagePart,
  type QualifiedName, type Session, type SuggestedFnCard, type SuggestionRecord, type TurnId, type UserInfo,
} from '@harness/core';
import { announce, systemsChanged, systemsNow } from './announce.ts';
import type { ChatDeps } from './deps.ts';
import { messageOf } from './errors.ts';
import type { CatalogEntry } from '../catalog/index.ts';
import type { MessageEnricher, SuggestionDecider } from './index.ts';
import { allowsSystem, callSystem, escapeAttribute, escapeBody } from './support.ts';
import { timeInfo, weekday } from '../execution/time.ts';
import type { AccessScope } from '../access/index.ts';
import { seesContextAs } from '../access/scope.ts';
import type { FnView, FnViewSource, ModeChoice } from '../contextor/index.ts';
import { modeChoice } from '../contextor/planner.ts';
import { fnHead, promptExamples } from '../contextor/render.ts';
import { CatalogFnViews, fnRefusal, readsAsMissing } from '../contextor/views.ts';
import { cardList, contextElement, fnElement } from '../contextor/xml.ts';
import { LlmPayloadType, parseValue, type LlmPayload } from '@harness/sdk';

/** The tags the hub's own extras carry for the LLM. */
export const EXTRA_TAGS = { 'local-time': 'local_time', 'suggested-context': 'suggested_context', 'suggested-fns': 'suggested_fns' } as const;

/** The tag each kind of suggestion block is written in. */
const SUGGESTION_TAGS = { 'suggest-context': EXTRA_TAGS['suggested-context'], 'suggest-fns': EXTRA_TAGS['suggested-fns'] } as const;

/** What every suggestion block's first line ends with. */
const ONCE = 'Nothing is suggested twice in a chat, so what was suggested earlier still stands.';

/**
 * The line at the top of `<suggested_context>`, by the toolset the message was sent in: the tools mode loads context
 * with `hub/load_context`, the static toolset with its `load` tool.
 */
export const SUGGESTED_CONTEXT_LINES: Readonly<Record<ChatModeType, string>> = {
  tools: `Context that may help: load what fits with hub/load_context (the fns it brings join your tools). ${ONCE}`,
  static: `Context that may help: load what fits with load (the fns it brings come with it). ${ONCE}`,
};

/**
 * The line at the top of `<suggested_fns>`, by the toolset the message was sent in. Only the static toolset can run a
 * fn by name (its `run`); in the tools mode a fn must be loaded into the tools before it can be called.
 */
export const SUGGESTED_FNS_LINES: Readonly<Record<ChatModeType, string>> = {
  tools: `Fns that may help. They are not in your tools yet: load the ones you will call with hub/load_fns, then call them. One marked available="no" can't be used now: tell the person what its reason says instead. ${ONCE}`,
  static: `Fns that may help: run one by its name with the args its card shows. One marked available="no" can't be used now: tell the person what its reason says instead. ${ONCE}`,
};

/** The toolset a suggestion block written before blocks said theirs is read in (build 1's default). */
const UNSTATED_TOOLSET: ChatModeType = DEFAULT_CHAT_MODE.type;

/** A message with nothing suggested. */
const NO_SUGGESTIONS: { parts: MessagePart[]; record?: SuggestionRecord } = { parts: [] };

/** A suggestion block's card list, in the toolset's words. */
function suggestionList(block: Extract<HookBlock, { type: 'suggest-context' | 'suggest-fns' }>): string {
  const toolset = block.toolset ?? UNSTATED_TOOLSET;
  if (block.type === 'suggest-context') {
    return cardList(SUGGESTION_TAGS[block.type], SUGGESTED_CONTEXT_LINES[toolset], block.items.map((item) => contextElement({ key: item.context, title: item.title, text: item.why ?? '' })));
  }
  return cardList(SUGGESTION_TAGS[block.type], SUGGESTED_FNS_LINES[toolset], block.items.map((item) => fnElement({
    name: item.fn, label: item.card?.label ?? fnLabel(item.fn), description: item.why ?? '', ...(item.card === undefined ? {} : item.card),
  })));
}

/** The names a message's parts suggest (the hub's and its hooks'), in order. */
export function suggestedIn(parts: readonly MessagePart[]): QualifiedName[] {
  return parts.flatMap((part) => (part.type === 'extra' || part.type === 'hook' ? part.blocks : [])).flatMap((block) => {
    switch (block.type) {
      case 'suggest-context': return block.items.map((item) => item.context);
      case 'suggest-fns': return block.items.map((item) => item.fn);
      case 'text': case 'load': return [];
    }
  });
}

/** A session's suggested set after a message with these parts was sent (nothing to change when they suggest nothing). */
export function suggestedAfter(session: Pick<Session, 'suggested'>, parts: readonly MessagePart[]): Pick<Session, 'suggested'> {
  const added = suggestedIn(parts);
  return added.length === 0 ? {} : { suggested: [...new Set([...(session.suggested ?? []), ...added])] };
}

/** Enriches and renders messages. */
export class HubMessageEnricher implements MessageEnricher {
  readonly #deps: Pick<ChatDeps, 'clock' | 'log' | 'settings' | 'catalog' | 'link' | 'access' | 'store'>;
  readonly #decider: Pick<SuggestionDecider, 'decide'>;
  readonly #views: FnViewSource;

  /** `views` shows suggested fns' signatures; by default straight from the catalog. */
  constructor(deps: Pick<ChatDeps, 'clock' | 'log' | 'settings' | 'catalog' | 'link' | 'access' | 'store'>, decider: Pick<SuggestionDecider, 'decide'>, views: FnViewSource = new CatalogFnViews(deps.catalog)) {
    this.#deps = deps;
    this.#decider = decider;
    this.#views = views;
  }

  async enrich(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<{ parts: MessagePart[]; suggestions?: SuggestionRecord; announcedSystems?: AnnouncedSystems }> {
    const choice = await this.#choice(input.session);
    // the graph contextor chooses context and fns for each prompt itself, so its sessions get no suggestion blocks
    const suggest = choice.contextor.type !== 'graph';
    const [systems, suggested, hooks] = await Promise.all([
      this.#systems(input.session, input.user.id), suggest ? this.#suggestions(input.session, input.text, input.user.id) : NO_SUGGESTIONS, this.#hooks(input),
    ]);
    const offered = await this.#offer([...suggested.parts, ...hooks], { session: input.session, actor: input.user.id, toolset: choice.mode.type });
    const parts = [...(systems.changed === undefined ? [] : [systems.changed]), this.#localTime(input.user), ...offered];
    return {
      parts, ...(suggested.record === undefined ? {} : { suggestions: suggested.record }), ...(systems.announced === undefined ? {} : { announcedSystems: systems.announced }),
    };
  }

  /** What changed in the session's systems for its person since the model was last told, and the snapshot after it. */
  async #systems(session: Session, actor: ActorId): Promise<ReturnType<typeof announce>> {
    return announce(session.announcedSystems, await systemsNow(this.#deps.store, await this.#deps.access.scope(actor), session));
  }

  /** A session's chat mode and contextor (its own choice, else its agent's). */
  async #choice(session: Session): Promise<ModeChoice> {
    // the agent's payload only matters when the session doesn't choose both itself
    const payload = session.mode === undefined || session.contextor === undefined ? await this.#agentChoice(session) : {};
    return modeChoice(session, payload);
  }

  /** The mode and contextor a session's agent fn asks for (none when it is gone or its payload doesn't parse, logged). */
  async #agentChoice(session: Session): Promise<Pick<LlmPayload, 'mode' | 'contextor'>> {
    const agent = await this.#deps.catalog.fn(session.agent);
    if (agent === undefined) return {};
    try {
      return parseValue(LlmPayloadType, agent.decl.payload);
    } catch (error) {
      this.#deps.log.warn('chat.agent.payload-unreadable', { session: session.id, agent: session.agent, error: messageOf(error) });
      return {};
    }
  }

  render(message: ChatMessage): string {
    // what changed in the systems is read first, before the person's words it may explain
    const first: string[] = [];
    const inline: string[] = [];
    const blocks: string[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case 'systems-changed': first.push(systemsChanged(part)); break;
        case 'text': inline.push(part.text); break;
        // the model reads its own reasoning and fn calls from the transcript, never from the message
        case 'reasoning': case 'call': break;
        // an undo note's list of what A/B variants left done is for people; the model never reads notes
        case 'kept-effects': break;
        case 'mention':
          inline.push(`<mention provider="${escapeAttribute(part.provider)}" label="${escapeAttribute(part.label)}">${escapeBody(part.text)}</mention>`);
          break;
        case 'command':
          inline.push(`<command context="${escapeAttribute(part.context)}"${attributes(part.args)} />`);
          break;
        case 'invocation': inline.push(`<invocation fn="${escapeAttribute(part.fn)}" run="${escapeAttribute(part.run)}" />`); break;
        case 'file':
          inline.push(`<file name="${escapeAttribute(part.name)}" mime="${escapeAttribute(part.ref.mime)}" size="${part.ref.size}" hash="${part.ref.hash}" />`);
          break;
        case 'extra': blocks.push(this.block(EXTRA_TAGS[part.extra], part.blocks)); break;
        case 'hook': blocks.push(this.block(hookTag(part.hook), part.blocks)); break;
        case 'attachment':
          blocks.push(`<attachment name="${escapeAttribute(part.attachment)}" title="${escapeAttribute(part.title)}">${escapeBody(JSON.stringify(part.data))}</attachment>`);
          break;
        case 'link': inline.push(linkTag(part.link)); break;
        // a form's answers: the model reads them, the chat shows the message only in debug mode
        case 'input-answer': blocks.push(`<${INPUT_ANSWER_TAG} title="${escapeAttribute(part.title)}">${escapeBody(part.text)}</${INPUT_ANSWER_TAG}>`); break;
      }
    }
    return [...first, inline.join(''), ...blocks].filter((s) => s !== '').join('\n\n');
  }

  block(tag: string, blocks: readonly HookBlock[]): string {
    const lines = blocks.map((block) => {
      switch (block.type) {
        case 'text': return `<${hookTag(block.tag)}>${escapeBody(block.text)}</${hookTag(block.tag)}>`;
        case 'suggest-context': case 'suggest-fns': return suggestionList(block);
        case 'load': return `Loaded: ${[...(block.context ?? []), ...(block.fns ?? [])].join(', ')}`;
      }
    });
    // the hub's own suggestions are one block in an extra of the same name: that block is the extra, not wrapped twice
    const [only] = blocks;
    if (blocks.length === 1 && (only?.type === 'suggest-context' || only?.type === 'suggest-fns') && SUGGESTION_TAGS[only.type] === tag) return lines[0] ?? '';
    return `<${tag}>\n${lines.join('\n')}\n</${tag}>`;
  }

  #localTime(user: UserInfo): MessagePart {
    const time = timeInfo(this.#deps.clock(), user.timeZone);
    const text = `${weekday(time.now, time.timeZone)} ${time.local} (${time.timeZone})`;
    return { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text }] };
  }

  /** The suggested context and fns as the extras the LLM reads, and the record of every candidate. */
  async #suggestions(session: Session, text: string, actor: ActorId): Promise<{ parts: MessagePart[]; record?: SuggestionRecord }> {
    let decided: Awaited<ReturnType<SuggestionDecider['decide']>>;
    try {
      decided = await this.#decider.decide({ session: session.id, text, actor });
    } catch (error) {
      this.#deps.log.warn('chat.suggest.failed', { session: session.id, error: messageOf(error) });
      return { parts: [] };
    }
    const ranked = [...decided.suggestions].sort((a, b) => b.score - a.score);
    const fns = ranked.filter((s) => s.kind === 'fn');
    const context = ranked.filter((s) => s.kind === 'context');
    const parts: MessagePart[] = [];
    if (context.length > 0) {
      parts.push({ type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', items: context.map((s) => ({ context: s.name, why: s.description, score: s.score })) }] });
    }
    if (fns.length > 0) {
      parts.push({ type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: fns.map((s) => ({ fn: s.name, why: s.description, score: s.score })) }] });
    }
    return decided.record === undefined ? { parts } : { parts, record: decided.record };
  }

  /**
   * The suggestions of a message's extras and hooks as they are sent: what this chat was suggested before (or this
   * message already suggests) left out, and so is what the session has loaded (it is in the prompt already), each
   * block stamped with the session's toolset, each fn's card snapshotted, a context's title added. A fn or context the
   * person can't see, one that is gone, or a fn not for the model, is left out. A block left with nothing goes, and a
   * part left with no blocks.
   */
  async #offer(parts: readonly MessagePart[], at: { session: Session; actor: ActorId; toolset: ChatModeType }): Promise<MessagePart[]> {
    const seen = new Set<string>([...(at.session.suggested ?? []), ...at.session.tools, ...at.session.context]);
    const out: MessagePart[] = [];
    let access: AccessScope | undefined;
    const scope = async (): Promise<AccessScope> => (access ??= await this.#deps.access.scope(at.actor));
    for (const part of parts) {
      if (part.type !== 'extra' && part.type !== 'hook') { out.push(part); continue; }
      const blocks: HookBlock[] = [];
      for (const block of part.blocks) {
        const offered = await this.#offerBlock(block, seen, { ...at, scope });
        if (offered !== undefined) blocks.push(offered);
      }
      if (blocks.length > 0) out.push({ ...part, blocks });
    }
    return out;
  }

  /** One block as `#offer` sends it; undefined when it suggests nothing new. */
  async #offerBlock(block: HookBlock, seen: Set<string>, at: { session: Session; toolset: ChatModeType; scope: () => Promise<AccessScope> }): Promise<HookBlock | undefined> {
    switch (block.type) {
      case 'text': case 'load': return block;
      case 'suggest-context': {
        const items: typeof block.items = [];
        for (const item of block.items) {
          if (seen.has(item.context)) continue;
          const record = await this.#deps.catalog.context(item.context);
          if (record === undefined || !seesContextAs(await at.scope(), record, at.session.id)) continue;
          seen.add(item.context);
          const title = item.title ?? record.decl.title;
          items.push(title === undefined ? item : { ...item, title });
        }
        return items.length === 0 ? undefined : { ...block, toolset: at.toolset, items };
      }
      case 'suggest-fns': {
        const items: typeof block.items = [];
        for (const item of block.items) {
          if (seen.has(item.fn)) continue;
          const card = item.card ?? await this.#card(item.fn, { session: at.session, access: await at.scope(), toolset: at.toolset });
          if (card === undefined) continue;
          seen.add(item.fn);
          items.push({ ...item, card });
        }
        return items.length === 0 ? undefined : { ...block, toolset: at.toolset, items };
      }
    }
  }

  /**
   * A suggested fn's card as of now: its label, mode, what blocks it (the Phase 1 refusal, in the hub's words) and
   * signature; in the static toolset, which runs it by name, its instructions and examples too. Undefined for a fn
   * that reads as missing (gone, unseen, not for the model). A signature that can't be read is left off, logged.
   */
  async #card(name: QualifiedName, at: { session: Session; access: AccessScope; toolset: ChatModeType }): Promise<SuggestedFnCard | undefined> {
    const record = await this.#deps.catalog.fn(name);
    const blocked = fnRefusal(record, at.session, at.access);
    if (record === undefined || (blocked !== undefined && readsAsMissing(blocked))) return undefined;
    let view: FnView | undefined;
    try {
      view = await this.#views.view(name);
    } catch (error) {
      this.#deps.log.warn('chat.suggest.signature-unreadable', { fn: name, error: messageOf(error) });
    }
    const head = fnHead(record, blocked?.reason);
    const examples = at.toolset === 'static' ? promptExamples(record) : undefined;
    return compact({
      label: head.label, mode: head.mode, blocked: head.blocked, args: view?.args, returns: view?.returns,
      instructions: at.toolset === 'static' ? record.decl.instructions : undefined,
      examples: examples === undefined || examples.shown.length === 0 ? undefined : [...examples.shown],
      moreExamples: examples === undefined || examples.more === 0 ? undefined : examples.more,
    });
  }

  async #hooks(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<MessagePart[]> {
    const hooks = (await this.#deps.catalog.entries('hooks'))
      .filter((h) => allowsSystem(input.session, h.system))
      .toSorted((a, b) => a.decl.order - b.decl.order || a.name.localeCompare(b.name));
    const time = timeInfo(this.#deps.clock(), input.user.timeZone);
    const message: HookInput = { session: input.session.id, turn: input.turn, text: input.text, user: input.user, time };
    const results = await Promise.all(hooks.map(async (hook) => this.#runHook(hook, message)));
    return results.flatMap((blocks, i) => {
      const hook = hooks[i];
      return hook === undefined || blocks.length === 0 ? [] : [{ type: 'hook' as const, hook: hook.name, blocks }];
    });
  }

  async #runHook(hook: CatalogEntry<'hooks'>, message: HookInput): Promise<HookBlock[]> {
    const available = await this.#deps.catalog.availability(hook.name);
    if (available !== true) { return []; }
    const started = this.#deps.clock();
    try {
      const blocks = await callSystem(this.#deps.link, hook.system, hook.decl.timeout, (c, signal) =>
        c.peer.call('hook', { hook: splitName(hook.name).local, message }, { signal }));
      this.#deps.log.debug('chat.hook.done', { hook: hook.name, blocks: blocks.length, time: this.#deps.clock() - started });
      return blocks;
    } catch (error) {
      this.#deps.log.warn('chat.hook.failed', { hook: hook.name, turn: message.turn, error: messageOf(error) });
      return [];
    }
  }
}

/** The LLM tag of a hook's blocks: `fs/git_branch` → `fs_git_branch`. */
export function hookTag(hook: string): string {
  return hook.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Tag attributes from a record; names are made tag-safe. */
function attributes(values: Readonly<Record<string, string | undefined>>): string {
  return Object.entries(values).map(([name, value]) => (value === undefined ? '' : ` ${hookTag(name)}="${escapeAttribute(value)}"`)).join('');
}

/** A link as the LLM sees it. */
function linkTag(link: Link): string {
  if ('resource' in link) { return `<link${attributes({ resource: link.resource, section: link.section, title: link.title })} />`; }
  if ('url' in link) { return `<link${attributes({ url: link.url, title: link.title })} />`; }
  if ('file' in link) { return `<link${attributes({ file: link.file.hash, title: link.title })} />`; }
  return `<link${attributes({ run: link.run, title: link.title })} />`;
}
