/**
 * A resource as message content for the model actually chosen (`MessageContent`), per part and never failing:
 *
 * - an image goes as an image part to a model that sees (`vision`), else as its description (made once and kept);
 * - a pdf goes as a file part to a model that takes files (`files`), else as its text;
 * - audio goes as an audio part to a model that hears (`hearing`), else as its transcript; video likewise
 *   (`videoInput`);
 * - everything else goes as the text of its primary form, and one section always as its text in that form.
 *
 * Anything that can't be made (no description model, unreadable bytes) becomes one short text part saying what the
 * resource is, so a message never fails because of an attachment. Parts carry the bytes as data URLs up to
 * `INLINE_MAX`; a larger one goes as its text form instead.
 */
import type { Logger } from '@ayepi/log';
import { messageOf, type LlmContentPart, type ResourceUri, type SectionKey } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { Asking, ContentModel, FormService, MessageContent, ResourceReader } from './index.ts';
import type { Snapshot } from './forms.ts';
import { familyOfStat } from './rules.ts';

/** The largest raw content sent inline as a data URL (bigger media go as their text form). */
export const INLINE_MAX = 20 * 1024 * 1024;

/** The media type of a pdf's raw bytes (a system's own text of a pdf goes as text). */
const PDF = 'application/pdf';

/** The model capability that lets each media part through, and the form that stands in for it otherwise. */
const MEDIA = {
  image: { capability: 'vision', part: 'image', form: 'description' },
  audio: { capability: 'hearing', part: 'audio', form: 'transcript' },
  video: { capability: 'videoInput', part: 'video', form: 'transcript' },
} as const;

/** What message content needs. */
export interface FormMessageContentOptions {
  readonly forms: FormService;
  /** Reads one section's text. */
  readonly reader: Pick<ResourceReader, 'read'>;
  readonly content: ContentStore;
  readonly log: Logger;
}

/** Message content over the forms service. */
export class FormMessageContent implements MessageContent {
  readonly #o: FormMessageContentOptions;

  constructor(options: FormMessageContentOptions) {
    this.#o = options;
  }

  async parts(uri: ResourceUri, model: ContentModel, who: Asking, options: { section?: SectionKey } = {}): Promise<LlmContentPart[]> {
    let record: Snapshot | undefined;
    try {
      record = await this.#o.forms.snapshot(uri, who);
      if (options.section !== undefined) {
        const read = await this.#o.reader.read({ uri, section: options.section }, who);
        const more = read.truncated ? `\n\n[${read.total - read.text.length} more characters: read the section with hub/resource_read]` : '';
        return [this.#text(record, `${read.text}${more}`, `${read.form}, ${options.section}`)];
      }
      const family = familyOfStat(record.stat);
      const media = family === 'image' || family === 'audio' || family === 'video' ? MEDIA[family] : undefined;
      if (media !== undefined) {
        if (model.capabilities.includes(media.capability) && record.raw.size <= INLINE_MAX) { return [await this.#inline(record, media.part)]; }
        const form = await this.#o.forms.ensure(uri, media.form, who);
        return [this.#text(record, await this.#o.forms.text(form), media.form)];
      }
      if (record.raw.mime === PDF && model.capabilities.includes('files') && record.raw.size <= INLINE_MAX) { return [await this.#inline(record, 'file')]; }
      const primary = await this.#o.forms.primary(uri, who, { make: true });
      return [this.#text(record, primary.text, primary.form)];
    } catch (error) {
      this.#o.log.warn('resources.content.fallback', { uri, model: model.id, error: messageOf(error) });
      const name = record?.stat.name ?? uri;
      const what = record?.stat.mime ?? record?.stat.format ?? 'a resource';
      return [{ type: 'text', content: `[${name}: ${what} at ${uri}, which could not be shown here (${messageOf(error)})]`, name }];
    }
  }

  /** The raw content as a data URL part. */
  async #inline(record: Snapshot, type: LlmContentPart['type']): Promise<LlmContentPart> {
    const bytes = await this.#o.content.read(record.raw, 0, record.raw.size);
    return { type, content: `data:${record.raw.mime};base64,${Buffer.from(bytes).toString('base64')}`, format: record.raw.mime, name: record.stat.name };
  }

  /** A text part headed with the resource's name and the form it is. */
  #text(record: Snapshot, text: string, form: string | undefined): LlmContentPart {
    const heading = `${record.stat.name} (${record.uri}${form === undefined ? '' : `, ${form}`})`;
    return { type: 'text', content: `${heading}\n\n${text}`, name: record.stat.name };
  }
}
