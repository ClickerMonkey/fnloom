/**
 * Dynamic context: a context item declared without `content` is written by its system when it is used (`fs/tree`,
 * `fs/system-authoring`). The hub asks the owning system's `context` link endpoint, as the person it is for and with
 * the args of the `/command` that pulled it in, and keeps the text for `HARNESS_DYNAMIC_CONTEXT_TTL` per session,
 * person and item, so every iteration of a turn sees the same text and a later load reuses the command's args.
 * Everything that shows context text (the contextors, `hub/inspect`, `hub/context_get`) reads it through here.
 */
import type { Logger } from '@ayepi/log';
import { messageOf, type ContextRecord, type QualifiedName, type SystemName, type systemLinkSpec, type UserInfo } from '@harness/core';
import type { z } from 'zod';
import { timeInfo } from '../execution/time.ts';
import type { ContextorEnv } from './env.ts';
import type { DynamicAsk, DynamicContext } from './index.ts';

/** What the hub sends a system's `context` endpoint, and what it answers. */
export type ContextWrite = z.infer<typeof systemLinkSpec.endpoints.context.cfg.body>;
export type ContextWritten = z.infer<typeof systemLinkSpec.endpoints.context.cfg.response>;

/** What the dynamic context service uses. */
export interface DynamicContextDeps {
  /** Ask a system's connected instance to write an item within `timeout`; undefined when none is connected. */
  readonly write: (system: SystemName, body: ContextWrite, timeout: number) => Promise<ContextWritten> | undefined;
  /** The person as systems see them, for asks that don't carry it (a web read, a preview). */
  readonly person: (actor: DynamicAsk['actor']) => Promise<UserInfo>;
  readonly settings: Pick<ContextorEnv, 'HARNESS_DYNAMIC_CONTEXT_TTL' | 'HARNESS_DYNAMIC_CONTEXT_TIMEOUT' | 'HARNESS_DYNAMIC_CONTEXT_CACHE'>;
  readonly log: Logger;
  readonly clock: () => number;
}

/** One fetched text, with the args it was written for. */
interface Fetched {
  readonly text: string;
  readonly args: Readonly<Record<string, string>>;
  readonly at: number;
}

/** Dynamic context fetched over the link, kept in memory per session, person and item. */
export class LinkDynamicContext implements DynamicContext {
  readonly #deps: DynamicContextDeps;
  readonly #cache = new Map<string, Fetched>();

  constructor(deps: DynamicContextDeps) {
    this.#deps = deps;
  }

  async resolve(record: ContextRecord, ask: DynamicAsk): Promise<ContextRecord> {
    if (record.decl.content !== undefined) return record;
    const text = await this.#text(record, ask);
    return text === undefined ? record : { ...record, decl: { ...record.decl, content: text } };
  }

  /** The item's text for this ask: kept, else fetched; the last kept text when the system can't answer. */
  async #text(record: ContextRecord, ask: DynamicAsk): Promise<string | undefined> {
    const key = cacheKey(record.name, ask);
    const kept = this.#cache.get(key);
    const args = ask.args ?? kept?.args ?? {};
    const fresh = kept !== undefined && this.#deps.clock() - kept.at < this.#deps.settings.HARNESS_DYNAMIC_CONTEXT_TTL && sameArgs(kept.args, args);
    if (fresh) return kept.text;
    try {
      const user = ask.user ?? await this.#deps.person(ask.actor);
      const written = this.#deps.write(record.system, {
        name: record.decl.name, args: { ...args }, actor: ask.actor, user, time: timeInfo(this.#deps.clock(), user.timeZone),
        ...(ask.session === undefined ? {} : { session: ask.session }),
      }, this.#deps.settings.HARNESS_DYNAMIC_CONTEXT_TIMEOUT);
      if (written === undefined) {
        this.#deps.log.warn('context.dynamic.unavailable', { context: record.name, system: record.system });
        return kept?.text;
      }
      const { text } = await written;
      this.#keep(key, { text, args, at: this.#deps.clock() });
      this.#deps.log.debug('context.dynamic.fetched', { context: record.name, chars: text.length });
      return text;
    } catch (error) {
      this.#deps.log.warn('context.dynamic.failed', { context: record.name, system: record.system, error: messageOf(error) });
      return kept?.text;
    }
  }

  /** Keep a text, dropping the oldest entries past the cache's size. */
  #keep(key: string, fetched: Fetched): void {
    this.#cache.delete(key);
    this.#cache.set(key, fetched);
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size <= this.#deps.settings.HARNESS_DYNAMIC_CONTEXT_CACHE) break;
      this.#cache.delete(oldest);
    }
  }
}

/** The cache key of an item for a session and person. */
function cacheKey(name: QualifiedName, ask: Pick<DynamicAsk, 'session' | 'actor'>): string {
  return JSON.stringify([ask.session ?? null, ask.actor, name]);
}

/** Whether two arg sets say the same. */
function sameArgs(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** A dynamic context service that fetches nothing (dynamic items keep their summary), for hubs and tests without a link. */
export const NO_DYNAMIC_CONTEXT: DynamicContext = { resolve: (record) => Promise.resolve(record) };
