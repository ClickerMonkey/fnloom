/**
 * Mentions: `@` search, hover cards, and the LLM text written when a message is sent. The hub's own providers
 * (`hub/fns`, `hub/context`, `hub/resources`) answer in the hub; every other provider is asked over its system's link,
 * as the person mentioning, so it only shows what they may see.
 */
import type { Peer } from '@ayepi/core';
import {
  ResourceUri, splitName, SystemName, type ActorId, type Asker, type Json, type MentionHover, type MentionOption, type MessagePart, type OutgoingPart, type QualifiedName, type Session, type SessionId,
  type SystemLinkSpec,
} from '@harness/core';
import { hub, parseValue } from '@harness/sdk';
import type { AccessScope } from '../access/index.ts';
import { seesContextAs, seesContextNamed } from '../access/scope.ts';
import { isHubName } from '../catalog/availability.ts';
import { parseSectionIndexKey } from '../index/indexer.ts';
import type { ChatDeps } from './deps.ts';
import { ChatError, messageOf } from './errors.ts';
import type { MentionAsk, MentionProvider, MentionRequest, MentionService } from './index.ts';
import type { People } from './people.ts';
import { allowsSystem, asQualified, callSystem, entryOf, participantOf, searchSystems } from './support.ts';

/** How many results the hub's own providers return. */
const HUB_RESULTS = 10;

/** The hub's own mention providers: fns, context and resources, from the catalog and the index. */
export class HubMentions implements MentionProvider {
  readonly #deps: Pick<ChatDeps, 'catalog' | 'search' | 'store' | 'access'>;

  constructor(deps: Pick<ChatDeps, 'catalog' | 'search' | 'store' | 'access'>) {
    this.#deps = deps;
  }

  /** Whether the asker may see what a hub mention names (a fn, a context item or a resource). */
  async #sees(access: AccessScope, session: SessionId, kind: 'fn' | 'context' | 'resource', key: string): Promise<boolean> {
    if (kind === 'resource') return access.seesUri(key);
    const name = asQualified(key);
    if (name === undefined) return false;
    if (kind === 'fn') return access.seesFn({ name, system: splitName(name).system });
    return seesContextNamed(access, (n) => this.#deps.catalog.context(n), name, session);
  }

  /** The options the asker may see, in order. */
  async #seen(access: AccessScope, session: SessionId, kind: 'fn' | 'context' | 'resource', options: ReadonlyArray<{ key: string; option: MentionOption }>): Promise<MentionOption[]> {
    const seen = await Promise.all(options.map(async (o) => ((await this.#sees(access, session, kind, o.key)) ? o.option : undefined)));
    return seen.filter((o) => o !== undefined);
  }

  serves(provider: QualifiedName): boolean {
    return isHubName(provider);
  }

  async search(ask: MentionAsk, query: string): Promise<MentionOption[]> {
    const session = await this.#deps.store.table('sessions').get(ask.session);
    const systems = session === undefined ? [] : searchSystems(session);
    const access = await this.#deps.access.scope(ask.actor);
    switch (ask.provider) {
      case hub.mentions.fns.name: {
        if (query.trim() === '') {
          const fns = await this.#deps.catalog.fns({ available: true });
          return fns.filter((f) => session !== undefined && allowsSystem(session, f.system) && access.mayUse(f)).slice(0, HUB_RESULTS)
            .map((f) => ({ label: f.name, hint: f.decl.description, target: { fn: f.name } }));
        }
        const hits = await this.#deps.search.search({ text: query, kinds: ['fn'], limit: HUB_RESULTS, systems });
        return this.#seen(access, ask.session, 'fn', hits.map((h) => ({ key: h.key, option: { label: h.key, hint: h.text, target: { fn: h.key } } })));
      }
      case hub.mentions.context.name: {
        const hits = await this.#deps.search.search({ text: query, kinds: ['context'], limit: HUB_RESULTS, systems });
        return this.#seen(access, ask.session, 'context', hits.map((h) => ({ key: h.key, option: { label: h.key, hint: h.text, target: { context: h.key } } })));
      }
      case hub.mentions.resources.name: {
        const hits = await this.#deps.search.search({ text: query, kinds: ['section'], limit: HUB_RESULTS, systems });
        return this.#seen(access, ask.session, 'resource', hits.map((h) => ({ key: parseSectionIndexKey(h.key).uri, option: { label: resourceLabel(h.key), hint: h.text, target: resourceTarget(h.key) } })));
      }
      default: return [];
    }
  }

  async hover(ask: MentionAsk, target: Json): Promise<MentionHover | undefined> {
    const access = await this.#deps.access.scope(ask.actor);
    switch (ask.provider) {
      case hub.mentions.fns.name: {
        const { fn } = parseValue(hub.mentions.fns.target, target);
        const record = await this.#deps.catalog.fn(qualified(fn));
        if (record === undefined || !access.seesFn(record)) { return undefined; }
        return {
          title: record.name,
          subtitle: `${record.system} · ${record.decl.kind === 'native' ? 'native' : record.decl.kind}`,
          body: record.decl.description,
          fields: [{ label: 'Available', value: record.available === true ? 'yes' : record.available.detail }, ...(record.decl.tags.length > 0 ? [{ label: 'Tags', value: record.decl.tags.join(', ') }] : [])],
        };
      }
      case hub.mentions.context.name: {
        const { context } = parseValue(hub.mentions.context.target, target);
        const record = await this.#deps.catalog.context(qualified(context));
        return record === undefined || !seesContextAs(access, record, ask.session) ? undefined : { title: record.name, subtitle: record.system, body: record.decl.description };
      }
      case hub.mentions.resources.name: {
        const { uri, section } = parseValue(hub.mentions.resources.target, target);
        if (!access.seesUri(uri)) { return undefined; }
        const resource = ResourceUri.safeParse(uri);
        const subtitle = section === undefined ? uri : `${uri} § ${section}`;
        return { title: resourceLabel(uri), subtitle, ...(resource.success ? { open: { resource: resource.data, title: resourceLabel(uri) } } : {}) };
      }
      default: return undefined;
    }
  }

  async text(ask: MentionAsk, target: Json): Promise<string> {
    const access = await this.#deps.access.scope(ask.actor);
    switch (ask.provider) {
      case hub.mentions.fns.name: {
        const { fn } = parseValue(hub.mentions.fns.target, target);
        const record = await this.#deps.catalog.fn(qualified(fn));
        if (record === undefined || !access.seesFn(record)) { return `The fn ${fn}, which the hub does not know.`; }
        const available = record.available === true ? '' : ` It can't be used now: ${record.available.detail}.`;
        return `The fn ${record.name} of the ${record.system} system: ${record.decl.description}${available}`;
      }
      case hub.mentions.context.name: {
        const { context } = parseValue(hub.mentions.context.target, target);
        const record = await this.#deps.catalog.context(qualified(context));
        return record === undefined || !seesContextAs(access, record, ask.session) ? `The context ${context}, which the hub does not know.` : `The context ${record.name} of the ${record.system} system: ${record.decl.description}`;
      }
      case hub.mentions.resources.name: {
        const { uri, section } = parseValue(hub.mentions.resources.target, target);
        if (!access.seesUri(uri)) { return `The resource ${uri}, which the hub does not know.`; }
        return section === undefined ? `The resource ${uri}.` : `The section "${section}" of the resource ${uri}.`;
      }
      default: throw new ChatError('not-found', `The hub has no mention provider ${ask.provider}.`);
    }
  }
}

/** Every other system's mention providers, asked over the link as the person mentioning. */
export class LinkedMentions implements MentionProvider {
  readonly #deps: Pick<ChatDeps, 'link' | 'settings'>;

  constructor(deps: Pick<ChatDeps, 'link' | 'settings'>) {
    this.#deps = deps;
  }

  serves(provider: QualifiedName): boolean {
    return !isHubName(provider);
  }

  async search(ask: MentionAsk, query: string): Promise<MentionOption[]> {
    return this.#call(ask, this.#deps.settings.chat.HARNESS_MENTION_SEARCH_TIMEOUT, (peer, body, signal) => peer.call('mentions', { ...body, query }, { signal }));
  }

  async hover(ask: MentionAsk, target: Json): Promise<MentionHover | undefined> {
    const { hover } = await this.#call(ask, this.#deps.settings.chat.HARNESS_MENTION_SEARCH_TIMEOUT, (peer, body, signal) => peer.call('mentionHover', { ...body, target }, { signal }));
    return hover;
  }

  async text(ask: MentionAsk, target: Json): Promise<string> {
    const { text } = await this.#call(ask, this.#deps.settings.chat.HARNESS_MENTION_TIMEOUT, (peer, body, signal) => peer.call('mentionText', { ...body, target }, { signal }));
    return text;
  }

  /** Call the provider's system with the asker and the provider's local name. */
  async #call<T>(ask: MentionAsk, timeout: number, call: (peer: Peer<SystemLinkSpec>, body: Asker & { provider: string }, signal: AbortSignal) => Promise<T>): Promise<T> {
    const { system, local } = splitName(ask.provider);
    return callSystem(this.#deps.link, SystemName.parse(system), timeout, (c, signal) => call(c.peer, { ...ask, provider: local }, signal));
  }
}

/** Mentions across the hub's own providers and every system's, limited to what a session allows. */
export class ChatMentions implements MentionService {
  readonly #deps: Pick<ChatDeps, 'store' | 'catalog' | 'log' | 'access'>;
  readonly #people: People;
  readonly #providers: readonly MentionProvider[];

  constructor(deps: Pick<ChatDeps, 'store' | 'catalog' | 'log' | 'access'>, people: People, providers: readonly MentionProvider[]) {
    this.#deps = deps;
    this.#people = people;
    this.#providers = providers;
  }

  async search(request: MentionRequest, query: string): Promise<MentionOption[]> {
    const session = await this.#session(request);
    const provider = await this.#provider(session, request.provider, request.actor);
    return provider.search(await this.#ask(request), query);
  }

  async hover(request: MentionRequest, target: Json): Promise<MentionHover | undefined> {
    const session = await this.#session(request);
    const provider = await this.#provider(session, request.provider, request.actor);
    await this.#check(request.provider, target);
    return provider.hover(await this.#ask(request), target);
  }

  async resolve(input: { session: Session; asker: Asker; parts: readonly OutgoingPart[] }): Promise<MessagePart[]> {
    return Promise.all(input.parts.map(async (part): Promise<MessagePart> => {
      if (part.type !== 'mention') { return part; }
      const provider = await this.#provider(input.session, part.provider, input.asker.actor);
      await this.#check(part.provider, part.target);
      try {
        return { ...part, text: await provider.text({ ...input.asker, provider: part.provider }, part.target) };
      } catch (error) {
        this.#deps.log.warn('chat.mention.text.failed', { provider: part.provider, session: input.session.id, error: messageOf(error) });
        return { ...part, text: `"${part.label}" from ${part.provider} (its details could not be fetched when this was sent).` };
      }
    }));
  }

  async #ask(request: MentionRequest): Promise<MentionAsk> {
    return { ...(await this.#people.asker(request.session, request.actor)), provider: request.provider };
  }

  async #session(request: MentionRequest): Promise<Session> {
    const session = await this.#deps.store.table('sessions').get(request.session);
    if (session === undefined || participantOf(session, request.actor) === undefined) { throw new ChatError('not-found', 'No such session.'); }
    return session;
  }

  /** The source for a provider the session allows and that can be used now. */
  async #provider(session: Session, name: QualifiedName, actor: ActorId): Promise<MentionProvider> {
    const { system } = splitName(name);
    if (!allowsSystem(session, system) || !(await this.#deps.access.scope(actor)).seesSystem(system)) { throw new ChatError('unavailable', `The ${system} system is not enabled in this session.`); }
    const available = await this.#deps.catalog.availability(name);
    if (available !== true) { throw new ChatError('unavailable', `The mention provider ${name} can't be used now: ${available.detail}.`); }
    const provider = this.#providers.find((p) => p.serves(name));
    if (provider === undefined) { throw new ChatError('not-found', `No mention provider ${name}.`); }
    return provider;
  }

  /** Refuse a target that isn't the provider's declared target type. */
  async #check(name: QualifiedName, target: Json): Promise<void> {
    const entry = await entryOf(this.#deps.catalog, 'mentions', name);
    if (entry === undefined) { throw new ChatError('not-found', `No mention provider ${name}.`); }
    const problems = await this.#deps.catalog.check(entry.system, entry.decl.target, target);
    if (problems.length > 0) { throw new ChatError('invalid', `That is not a ${name} target: ${problems.join('; ')}`); }
  }
}

/** A qualified name from a hub mention target, refused when it isn't one. */
function qualified(name: string): QualifiedName {
  const parsed = asQualified(name);
  if (parsed === undefined) { throw new ChatError('invalid', `${name} is not a qualified name (system/name).`); }
  return parsed;
}

/** A resource hit's key is its URI, with `#section` when the hit is one section. */
function resourceTarget(key: string): { uri: string; section?: string } {
  const at = key.indexOf('#');
  return at < 0 ? { uri: key } : { uri: key.slice(0, at), section: key.slice(at + 1) };
}

/** The last part of a URI's path, for a chip. */
function resourceLabel(key: string): string {
  const { uri } = resourceTarget(key);
  const trimmed = uri.replace(/\/+$/, '');
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last) || uri;
  } catch {
    // A malformed escape (a stray %) is shown as written.
    return last || uri;
  }
}
