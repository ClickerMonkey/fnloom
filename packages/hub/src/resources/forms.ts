/**
 * Forms of raw content (`FormService`). A resource's raw content is kept in the content store (a hub resource's only
 * copy, or a snapshot of what a system served, fetched again when the system's version changes). Forms are rows of
 * the `forms` table keyed by the raw content's hash, kind and converter, with their bytes in the content store:
 *
 * - **Converted** forms (markdown, tables, pages, pretty code) come from the shared `@aeye/resources` registry. They
 *   are cheap and made on first look. A stored one is current while its converter is still the one that would run;
 *   a converter that declines is remembered for that hash, so raw text formats aren't asked again on every read.
 * - **Model-made** forms (descriptions, text in images, transcripts) come from `FormModels`, only when asked for
 *   (or while indexing with `HARNESS_DESCRIBE_ON_INDEX`), and are reused whatever model made them.
 *
 * One job per key runs at a time (two readers wait on one), at most `HARNESS_FORM_CONCURRENCY` at once, people's
 * reads before indexing. The same bytes at two URIs share their forms. Each record's `forms` and `primary` follow
 * what exists, and `onForms` hears when they change (the browser's badges).
 */
import { reject } from '@ayepi/core';
import { doWith, priorityDoer, type Doer } from '@ayepi/core/doer';
import type { Logger } from '@ayepi/log';
import { versionText } from '@aeye/resources/versions';
import {
  CONVERTED_VERSION_MIME, ConvertedVersion, isConvertedKind, messageOf, type ContentRef, type FormKind, type FormOffer, type FormRecord, type MadeFormKind,
  type ResourceForms, type ResourceRecord, type ResourceUri,
} from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import { allRows } from '../store/rows.ts';
import type { PrimaryText } from '../index/index.ts';
import type { HubStore } from '../store/index.ts';
import type { ResourcesEnv } from './env.ts';
import type { Asking, Converters, FormModels, FormService } from './index.ts';
import type { RawReader } from './raw.ts';
import { estimateTokens, familyOfStat, isHubUri, kindsOf, madeKindsFor, primaryOf, textOf } from './rules.ts';

/** A resource record whose raw content is in the store. */
export type Snapshot = ResourceRecord & { readonly raw: ContentRef };

/** How urgent a form job is: someone is waiting for it, or it is the index's background work. */
type Urgency = 'interactive' | 'background';

/** The doer priority of each urgency. */
const PRIORITY: Readonly<Record<Urgency, number>> = { interactive: 1, background: 0 };

/** How many declined conversions are remembered (raw hash and type), oldest forgotten first. */
const DECLINED_KEPT = 5_000;

/** The error code of a system resource whose system sent neither bytes nor text (a file over its text cap). */
export const NO_CONTENT = 'NO_CONTENT';

/** The media type text forms are stored with. */
const TEXT_MIME = 'text/plain; charset=utf-8';

/** What the forms service needs. */
export interface StoreFormServiceOptions {
  readonly store: HubStore;
  readonly content: ContentStore;
  readonly raw: RawReader;
  readonly converters: Converters;
  readonly models: FormModels;
  readonly log: Logger;
  readonly clock: () => number;
  readonly settings: Pick<ResourcesEnv, 'HARNESS_IMPORT_MAX' | 'HARNESS_FORM_CONCURRENCY'>;
  /** Told when a record's forms or primary form changed. */
  readonly onForms?: (record: ResourceRecord) => void;
}

/** UTF-8 bytes of a text. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Forms over the hub's store and content store. */
export class StoreFormService implements FormService {
  readonly #o: StoreFormServiceOptions;
  readonly #doer: Doer;
  /** The job running for each key, by what it makes, so a second caller waits on the first. */
  readonly #fetching = new Map<string, Promise<Snapshot>>();
  readonly #converting = new Map<string, Promise<FormRecord | undefined>>();
  readonly #making = new Map<string, Promise<FormRecord>>();
  /** Raw hashes and types whose converters declined (or failed): their raw text is the LLM-ready form. */
  readonly #declined = new Set<string>();

  constructor(options: StoreFormServiceOptions) {
    this.#o = options;
    this.#doer = priorityDoer({ max: options.settings.HARNESS_FORM_CONCURRENCY, now: options.clock });
  }

  async snapshot(uri: ResourceUri, _who: Asking): Promise<Snapshot> {
    const record = await this.#o.store.table('resources').get(uri);
    if (isHubUri(uri)) {
      if (record?.raw === undefined) { throw reject(404, 'NO_RESOURCE', `there is no hub resource ${uri}`); }
      return { ...record, raw: record.raw };
    }
    if (record?.raw !== undefined) {
      const raw = record.raw;
      const stat = await this.#o.raw.stat(uri);
      if (stat?.version === record.stat.version && await this.#o.content.has(raw)) { return { ...record, raw }; }
    }
    return this.#once(this.#fetching, uri, 'interactive', () => this.#fetch(uri));
  }

  async forms(uri: ResourceUri, who: Asking): Promise<ResourceForms> {
    const record = await this.snapshot(uri, who);
    // cheap forms are made on first look
    await this.#converted(record, 'interactive');
    const forms = await this.#current(record);
    const updated = await this.#note(record, forms);
    const present = new Set(forms.map((form) => form.kind));
    const offers: FormOffer[] = [];
    for (const kind of madeKindsFor(familyOfStat(record.stat))) {
      if (present.has(kind)) { continue; }
      const model = await this.#o.models.model(kind);
      offers.push(model === undefined ? { kind } : { kind, model });
    }
    return { record: updated, forms, offers };
  }

  async ensure(uri: ResourceUri, kind: FormKind, who: Asking): Promise<FormRecord> {
    const record = await this.snapshot(uri, who);
    const form = isConvertedKind(kind) ? await this.#converted(record, 'interactive') : await this.#made(record, kind, who);
    if (form?.kind !== kind) {
      const has = kindsOf(await this.#current(record));
      throw reject(404, 'NO_FORM', `${uri} has no ${kind} form${has.length === 0 ? '' : ` (it has ${has.join(', ')})`}`);
    }
    await this.#note(record, await this.#current(record));
    return form;
  }

  async primary(uri: ResourceUri, who: Asking, options: { make?: boolean; signal?: AbortSignal } = {}): Promise<PrimaryText> {
    const record = await this.snapshot(uri, who);
    const base = { stat: record.stat, links: record.links };
    const converted = await this.#converted(record, options.make === true ? 'interactive' : 'background');
    try {
      if (converted !== undefined) {
        const version = await this.version(converted);
        return { ...base, text: versionText(version), form: converted.kind, version };
      }
      const [best] = madeKindsFor(familyOfStat(record.stat));
      if (best !== undefined) {
        const form = (await this.#rows(record.raw.hash, best))[0] ?? (options.make === true ? await this.#made(record, best, who) : undefined);
        if (form !== undefined) { return { ...base, text: await this.text(form), form: best }; }
      }
      return { ...base, text: textOf(await this.#bytes(record.raw)) ?? '' };
    } finally {
      await this.#note(record, await this.#current(record));
    }
  }

  async text(form: FormRecord): Promise<string> {
    return isConvertedKind(form.kind) ? versionText(await this.version(form)) : new TextDecoder().decode(await this.#bytes(form.content));
  }

  async version(form: FormRecord): Promise<ConvertedVersion> {
    if (!isConvertedKind(form.kind)) { throw reject(422, 'NOT_CONVERTED', `a ${form.kind} form is not a converted version`); }
    return ConvertedVersion.parse(JSON.parse(new TextDecoder().decode(await this.#bytes(form.content))));
  }

  /** Fetch a system resource's raw content into the store, and keep its record. */
  async #fetch(uri: ResourceUri): Promise<Snapshot> {
    const { store, content, clock, settings } = this.#o;
    const raw = await this.#o.raw.read(uri);
    const served = raw.bytes === undefined ? 'text' : 'bytes';
    const bytes = raw.bytes ?? (raw.text === undefined ? undefined : utf8(raw.text));
    if (bytes === undefined) { throw reject(422, NO_CONTENT, `${raw.system} sent no content for ${uri}`); }
    if (bytes.length > settings.HARNESS_IMPORT_MAX) { throw reject(413, 'TOO_LARGE', `${uri} is ${bytes.length} bytes, over the hub's ${settings.HARNESS_IMPORT_MAX}`); }
    const ref = await content.put(bytes, served === 'bytes' ? raw.stat.mime ?? 'application/octet-stream' : TEXT_MIME);
    const latest = await store.table('resources').get(uri);
    const kinds = kindsOf(await allRows(store.table('forms'), { where: { hash: ref.hash } }));
    const primary = primaryOf(familyOfStat(raw.stat), kinds);
    const record: Snapshot = {
      ...latest, uri, system: raw.system, stat: raw.stat, links: raw.links, source: { from: 'system', system: raw.system, served }, raw: ref,
      forms: kinds, ...(primary === undefined ? {} : { primary }), seenAt: clock(),
    };
    if (primary === undefined) { delete record.primary; }
    await store.table('resources').put(record);
    this.#o.log.debug('resources.snapshot', { uri, system: raw.system, hash: ref.hash, size: ref.size, served });
    return record;
  }

  /** The type a snapshot converts as: a system's own text is never converted again. */
  #typeOf(record: Snapshot): string {
    if (record.source?.from === 'system' && record.source.served === 'text') { return 'text'; }
    return record.stat.format ?? this.#o.converters.typeOf(record.uri, record.raw.mime) ?? 'text';
  }

  /** The current converted form of a snapshot, made now when there is none; undefined when its raw text is LLM-ready. */
  async #converted(record: Snapshot, urgency: Urgency): Promise<FormRecord | undefined> {
    const type = this.#typeOf(record);
    const current = this.#o.converters.current(type);
    if (current.length === 0) { return undefined; }
    const { hash } = record.raw;
    const found = (await allRows(this.#o.store.table('forms'), { where: { hash } })).find((form) => isConvertedKind(form.kind) && current.includes(form.converter));
    if (found !== undefined) { return found; }
    const declined = `${hash}:${type}:${current.join(',')}`;
    if (this.#declined.has(declined)) { return undefined; }
    return this.#once(this.#converting, `${hash}:${type}`, urgency, async () => {
      const { content, store, clock, log } = this.#o;
      let made: Awaited<ReturnType<Converters['convert']>>;
      try {
        made = await this.#o.converters.convert({ bytes: await this.#bytes(record.raw), type, location: record.uri, name: record.stat.name, mime: record.raw.mime });
      } catch (error) {
        log.warn('resources.convert.failed', { uri: record.uri, hash, type, error: messageOf(error) });
        made = undefined;
      }
      if (made === undefined) { this.#decline(declined); return undefined; }
      const text = versionText(made.version);
      const form: FormRecord = {
        hash, kind: made.version.kind, converter: made.converter, content: await content.put(utf8(JSON.stringify(made.version)), CONVERTED_VERSION_MIME),
        chars: text.length, tokens: estimateTokens(text), createdAt: clock(),
      };
      await store.table('forms').put(form);
      log.info('resources.converted', { uri: record.uri, hash, kind: form.kind, converter: form.converter, chars: form.chars });
      return form;
    });
  }

  /** A model-made form of a snapshot, made now when there is none. */
  async #made(record: Snapshot, kind: MadeFormKind, who: Asking): Promise<FormRecord> {
    const { hash } = record.raw;
    const [found] = await this.#rows(hash, kind);
    if (found !== undefined) { return found; }
    return this.#once(this.#making, `${hash}:${kind}`, 'interactive', async () => {
      const { content, store, clock, log } = this.#o;
      const made = await this.#o.models.make(kind, { raw: record.raw, bytes: await this.#bytes(record.raw), name: record.stat.name }, who);
      const form: FormRecord = {
        hash, kind, converter: `model:${made.model}`, content: await content.put(utf8(made.text), TEXT_MIME), chars: made.text.length, tokens: estimateTokens(made.text),
        ...(made.call === undefined ? {} : { call: made.call }), createdAt: clock(),
      };
      await store.table('forms').put(form);
      log.info('resources.made', { uri: record.uri, hash, kind, model: made.model, chars: form.chars, ...(who.run === undefined ? {} : { run: who.run }) });
      return form;
    });
  }

  /** The forms of a raw hash, of one kind or all, newest first. */
  async #rows(hash: string, kind?: FormKind): Promise<FormRecord[]> {
    const rows = await allRows(this.#o.store.table('forms'), { where: kind === undefined ? { hash } : { hash, kind } });
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** A snapshot's forms that are current: converted ones by a converter that would still run, and every made one. */
  async #current(record: Snapshot): Promise<FormRecord[]> {
    const current = this.#o.converters.current(this.#typeOf(record));
    return (await this.#rows(record.raw.hash)).filter((form) => !isConvertedKind(form.kind) || current.includes(form.converter));
  }

  /** Keep a record's `forms` and `primary` in step with its forms, and say so when they changed. */
  async #note(record: Snapshot, forms: readonly FormRecord[]): Promise<Snapshot> {
    const kinds = kindsOf(forms);
    const primary = primaryOf(familyOfStat(record.stat), kinds);
    if (record.primary === primary && (record.forms ?? []).join() === kinds.join()) { return record; }
    const latest = await this.#o.store.table('resources').get(record.uri);
    if (latest === undefined) { return record; }
    const next: Snapshot = { ...latest, raw: record.raw, forms: kinds, ...(primary === undefined ? {} : { primary }) };
    if (primary === undefined) { delete next.primary; }
    await this.#o.store.table('resources').put(next);
    this.#o.onForms?.(next);
    return next;
  }

  /** The bytes of stored content. */
  #bytes(ref: ContentRef): Promise<Uint8Array> {
    return this.#o.content.read(ref, 0, ref.size);
  }

  /** Remember a declined conversion, forgetting the oldest past the cap. */
  #decline(key: string): void {
    this.#declined.add(key);
    if (this.#declined.size > DECLINED_KEPT) {
      const [oldest] = this.#declined;
      if (oldest !== undefined) { this.#declined.delete(oldest); }
    }
  }

  /** Run one job per key at a time under the doer: a second caller with the same key waits on the first. */
  #once<T>(jobs: Map<string, Promise<T>>, key: string, urgency: Urgency, job: () => Promise<T>): Promise<T> {
    const running = jobs.get(key);
    if (running !== undefined) { return running; }
    const started = doWith(this.#doer, job, { priority: PRIORITY[urgency], group: urgency }).finally(() => { jobs.delete(key); });
    jobs.set(key, started);
    return started;
  }
}
