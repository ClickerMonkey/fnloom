/**
 * What is added to a user message before the LLM sees it, and the text the LLM gets for a message. The hub adds the
 * person's local time and the fns and context the message's embedding suggests; then each hook of the session's
 * systems adds its own blocks, in hook order. Every addition is a tagged block, so the model tells it from the
 * person's words.
 */
import { splitName, type ChatMessage, type HookBlock, type HookInput, type Link, type MessagePart, type Session, type Suggestion, type TurnId, type UserInfo } from '@harness/core';
import type { ChatDeps } from './deps.ts';
import { messageOf } from './errors.ts';
import type { CatalogEntry } from '../catalog/index.ts';
import type { MessageEnricher } from './index.ts';
import { allowsSystem, callSystem, escapeAttribute, escapeBody } from './support.ts';
import { timeInfo, weekday } from '../execution/time.ts';

/** The tags the hub's own extras carry for the LLM. */
export const EXTRA_TAGS = { 'local-time': 'local_time', 'suggested-context': 'suggested_context', 'suggested-fns': 'suggested_fns' } as const;

/** Enriches and renders messages. */
export class HubMessageEnricher implements MessageEnricher {
  readonly #deps: Pick<ChatDeps, 'clock' | 'log' | 'settings' | 'suggest' | 'catalog' | 'link'>;

  constructor(deps: Pick<ChatDeps, 'clock' | 'log' | 'settings' | 'suggest' | 'catalog' | 'link'>) {
    this.#deps = deps;
  }

  async enrich(input: { session: Session; turn: TurnId; text: string; user: UserInfo }): Promise<MessagePart[]> {
    const [suggested, hooks] = await Promise.all([this.#suggestions(input.session, input.text), this.#hooks(input)]);
    return [this.#localTime(input.user), ...suggested, ...hooks];
  }

  render(message: ChatMessage): string {
    const inline: string[] = [];
    const blocks: string[] = [];
    for (const part of message.parts) {
      switch (part.type) {
        case 'text': inline.push(part.text); break;
        case 'reasoning': break;
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
      }
    }
    return [inline.join(''), ...blocks].filter((s) => s !== '').join('\n\n');
  }

  block(tag: string, blocks: readonly HookBlock[]): string {
    const lines = blocks.map((block) => {
      switch (block.type) {
        case 'text': return `<${hookTag(block.tag)}>${escapeBody(block.text)}</${hookTag(block.tag)}>`;
        case 'suggest-context': return block.items.map((i) => `- context ${i.context}${i.why === undefined ? '' : `: ${escapeBody(i.why)}`}`).join('\n');
        case 'suggest-fns': return block.items.map((i) => `- fn ${i.fn}${i.why === undefined ? '' : `: ${escapeBody(i.why)}`}`).join('\n');
        case 'load': return `Loaded: ${[...(block.context ?? []), ...(block.fns ?? [])].join(', ')}`;
      }
    });
    return `<${tag}>\n${lines.join('\n')}\n</${tag}>`;
  }

  #localTime(user: UserInfo): MessagePart {
    const time = timeInfo(this.#deps.clock(), user.timeZone);
    const text = `${weekday(time.now, time.timeZone)} ${time.local} (${time.timeZone})`;
    return { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'now', text }] };
  }

  async #suggestions(session: Session, text: string): Promise<MessagePart[]> {
    const limit = this.#deps.settings.model.HARNESS_SUGGESTIONS;
    if (limit === 0 || text.trim() === '') { return []; }
    let suggestions: Suggestion[];
    try {
      suggestions = await this.#deps.suggest.suggest({ session: session.id, text, limit });
    } catch (error) {
      this.#deps.log.warn('chat.suggest.failed', { session: session.id, error: messageOf(error) });
      return [];
    }
    const ranked = [...suggestions].sort((a, b) => b.score - a.score);
    const fns = ranked.filter((s) => s.kind === 'fn');
    const context = ranked.filter((s) => s.kind === 'context');
    const parts: MessagePart[] = [];
    if (context.length > 0) {
      parts.push({ type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', items: context.map((s) => ({ context: s.name, why: s.description, score: s.score })) }] });
    }
    if (fns.length > 0) {
      parts.push({ type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: fns.map((s) => ({ fn: s.name, why: s.description, score: s.score })) }] });
    }
    return parts;
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
