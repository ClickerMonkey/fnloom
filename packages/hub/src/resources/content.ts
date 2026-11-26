/**
 * A resource as message content for the model actually chosen (`MessageContent`), per part and never failing:
 *
 * - an image goes as an image part to a model that sees (`vision`), else as an `<image>` block (`images.ts`): its id,
 *   what is known of it, and how to ask about it with `hub/image_read`;
 * - a pdf goes as a file part to a model that takes files (`files`), else as its text; a pdf (or one page of it) with
 *   no text is pictures of pages (a scan), which go as those pictures to a model that sees, read out of the file
 *   (`pdf-pages.ts`), else as a note on asking about a page with `hub/image_read`;
 * - audio goes as an audio part to a model that hears (`hearing`), else as its transcript; video likewise
 *   (`videoInput`);
 * - everything else goes as the text of its primary form, and one section always as its text in that form.
 *
 * Anything that can't be made (no description model, unreadable bytes) becomes one short text part saying what the
 * resource is, so a message never fails because of an attachment, and an image part goes only when its bytes are a
 * picture of a kind providers take (`imagePartProblem`), else a note saying why. Parts carry the bytes as data URLs
 * up to `INLINE_MAX`; a larger one goes as its text form instead.
 */
import type { Logger } from '@ayepi/log';
import { imagePartProblem, messageOf, type LlmContentPart, type ResourceUri, type SectionKey } from '@harness/core';
import type { ContentStore } from '../api/index.ts';
import type { Asking, ContentModel, FormService, MessageContent, ResourceReader } from './index.ts';
import type { Snapshot } from './forms.ts';
import { IMAGE_HEAD_BYTES, IMAGE_READ_FN, imageBlock, imageSize } from './images.ts';
import { pdfPictures } from './pdf-pages.ts';
import { familyOfStat } from './rules.ts';

/** The largest raw content sent inline as a data URL (bigger media go as their text form). */
export const INLINE_MAX = 20 * 1024 * 1024;

/** The media type of a pdf's raw bytes (a system's own text of a pdf goes as text). */
const PDF = 'application/pdf';

/** The most pages of a pdf with no text that go as their pictures when the whole pdf is sent. */
export const PICTURE_PAGES = 4;

/** A page section's number (`Page 3` is 3), or undefined for any other section. */
export function pageNumber(section: string): number | undefined {
  const match = /(?:^|>\s*)page\s+(\d+)$/i.exec(section.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The model capability that lets each media part through, and the form that stands in for it otherwise. */
const MEDIA = {
  image: { capability: 'vision', part: 'image', form: 'description' },
  audio: { capability: 'hearing', part: 'audio', form: 'transcript' },
  video: { capability: 'videoInput', part: 'video', form: 'transcript' },
} as const;

/**
 * The note that stands in for a file that is marked as a picture but can't go to the model as one (its bytes aren't a
 * picture, or not a kind providers take): a provider refuses the whole conversation over such a part, every turn.
 */
export function unshowable(record: Pick<Snapshot, 'uri' | 'stat'>, problem: string): LlmContentPart {
  const text = `[${record.stat.name} (${record.uri}) can't be shown to you as a picture: ${problem}. Read what it holds with hub/resource_read and uri ${JSON.stringify(record.uri)}, or tell the person it couldn't be opened as a picture.]`;
  return { type: 'text', content: text, name: record.stat.name };
}

/** What message content needs. */
export interface FormMessageContentOptions {
  readonly forms: FormService;
  /** Reads one section's text. */
  readonly reader: Pick<ResourceReader, 'read'>;
  readonly content: ContentStore;
  readonly log: Logger;
  /**
   * Whether a vision model is set up to answer questions about an image (`hub/image_read`, the `describe` role), so an
   * image's block says how to ask about it, or that nobody can. Absent: none is.
   */
  readonly answersImages?: () => Promise<boolean>;
}

/** Message content over the forms service. */
export class FormMessageContent implements MessageContent {
  readonly #o: FormMessageContentOptions;

  constructor(options: FormMessageContentOptions) {
    this.#o = options;
  }

  async parts(uri: ResourceUri, model: ContentModel, who: Asking, options: { section?: SectionKey; source?: string } = {}): Promise<LlmContentPart[]> {
    let record: Snapshot | undefined;
    try {
      record = await this.#o.forms.snapshot(uri, who);
      if (options.section !== undefined) {
        const read = await this.#o.reader.read({ uri, section: options.section }, who);
        // a pdf page with no text is a picture of a page (a scan): it goes as that picture, or says how to read it
        const page = record.raw.mime === PDF && read.text.trim() === '' ? pageNumber(options.section) : undefined;
        if (page !== undefined) { return this.#pictures(record, model, [page]); }
        const more = read.partial === undefined ? '' : `\n\n[${read.partial}]`;
        return [this.#text(record, `${read.text}${more}`, `${read.form}, ${options.section}`)];
      }
      const family = familyOfStat(record.stat);
      const media = family === 'image' || family === 'audio' || family === 'video' ? MEDIA[family] : undefined;
      if (media !== undefined) {
        const fits = record.raw.size <= INLINE_MAX;
        if (model.capabilities.includes(media.capability) && fits) {
          const part = await this.#inline(record, media.part);
          // only a real picture of a kind providers take goes as one; anything else is its block, which says why
          const problem = media.part === 'image' ? imagePartProblem(part.content) : undefined;
          if (problem === undefined) { return [part]; }
          return [unshowable(record, problem)];
        }
        // an image the model can't take is an <image> block it can ask about (hub/image_read), never a picture or a guess
        if (family === 'image') { return [await this.#imageBlock(record, options.source, model.capabilities.includes(media.capability) ? 'This image is too large to show here, so it is described by this block instead.' : undefined)]; }
        const form = await this.#o.forms.ensure(uri, media.form, who);
        return [this.#text(record, await this.#o.forms.text(form), media.form)];
      }
      if (record.raw.mime === PDF && model.capabilities.includes('files') && record.raw.size <= INLINE_MAX) { return [await this.#inline(record, 'file')]; }
      const primary = await this.#o.forms.primary(uri, who, { make: true });
      if (record.raw.mime === PDF && primary.version?.kind === 'pages' && primary.text.replace(/\f/g, '').trim() === '') {
        const count = primary.version.pages.length;
        return this.#pictures(record, model, Array.from({ length: Math.min(count, PICTURE_PAGES) }, (_, i) => i + 1), count);
      }
      return [this.#text(record, primary.text, primary.form)];
    } catch (error) {
      this.#o.log.warn('resources.content.fallback', { uri, model: model.id, error: messageOf(error) });
      const name = record?.stat.name ?? uri;
      const what = record?.stat.mime ?? record?.stat.format ?? 'a resource';
      return [{ type: 'text', content: `[${name}: ${what} at ${uri}, which could not be shown here (${messageOf(error)})]`, name }];
    }
  }

  /**
   * Pages of a pdf that has no text on them (a scan): to a model that sees, each page's picture after a line saying
   * what it is; to one that can't, a note saying the pages are pictures and how to ask about one with hub/image_read.
   * A page with no picture that can be read out of the file says so plainly, so the model never thinks it saw it.
   */
  async #pictures(record: Snapshot, model: ContentModel, pages: readonly number[], total?: number): Promise<LlmContentPart[]> {
    const name = record.stat.name;
    const pictures = pdfPictures(await this.#o.content.read(record.raw, 0, record.raw.size));
    const count = Math.max(total ?? 0, pictures.pages);
    const sees = model.capabilities.includes('vision');
    const answerable = !sees && await (this.#o.answersImages?.() ?? Promise.resolve(false)).catch(() => false);
    const found = pages.flatMap((page) => { const picture = pictures.images[page - 1]; return picture === undefined ? [] : [picture]; });
    const missing = pages.filter((page) => pictures.images[page - 1] === undefined);
    // the whole pdf has no text, or only this page of it
    const lead = total === undefined
      ? `Page ${pages.join(', ')} of ${name} (${record.uri}) has no text: it is a picture of the page (a scan or a photo of paper), so its text is empty.`
      : `${name} (${record.uri}) has no text in it: its pages are pictures (a scan or a photo of paper), so its text form is empty.`;
    const shown = pages.length === 1 ? `This is page ${pages[0]}` : `These are pages ${pages.join(', ')}`;
    const rest = pages.length < count ? ` ${shown} of its ${count}: see another with hub/resource_send and section "Page <number>".` : '';
    const parts: LlmContentPart[] = [];
    if (sees && found.length > 0) {
      parts.push({ type: 'text', content: `${lead} Here ${found.length === 1 ? `is the picture of page ${found[0]?.page}` : `are the pictures of pages ${found.map((picture) => picture.page).join(', ')}`}: read what the page says from it.${rest}`, name });
      for (const picture of found) {
        parts.push({ type: 'image', content: `data:${picture.mime};base64,${Buffer.from(picture.bytes).toString('base64')}`, format: picture.mime, name: `${name}, page ${picture.page}` });
      }
    } else if (found.length > 0) {
      const how = answerable
        ? `To learn what a page says, call ${IMAGE_READ_FN} with {"image": ${JSON.stringify(record.uri)}, "page": ${found[0]?.page ?? 1}, "question": "<what you need to know>"}: a model that can see images looks at that page and answers.`
        : 'No model that can see images is set up, so what its pages say can\'t be read here: tell the person (an admin can set one up under Models).';
      parts.push({ type: 'text', content: `${lead} You can't see pictures here. ${how}${rest}`, name });
    }
    if (missing.length > 0) {
      const which = missing.length === 1 ? `Page ${missing[0]}` : `Pages ${missing.join(', ')}`;
      const says = missing.length === 1 ? 'has no picture that can be shown here, so what it says' : 'have no picture that can be shown here, so what they say';
      parts.push({ type: 'text', content: `${found.length === 0 ? `${lead} ` : ''}${which} of ${name} ${says} can't be read: tell the person, and don't guess.`, name });
    }
    return parts;
  }

  /** An image as a model that can't see it reads it: its facts, its id and how to ask about it. */
  async #imageBlock(record: Snapshot, source: string | undefined, reason: string | undefined): Promise<LlmContentPart> {
    const head = await this.#o.content.read(record.raw, 0, Math.min(record.raw.size, IMAGE_HEAD_BYTES)).catch(() => new Uint8Array());
    const answerable = await (this.#o.answersImages?.() ?? Promise.resolve(false)).catch(() => false);
    const content = imageBlock({
      id: record.uri, name: record.stat.name, mime: record.raw.mime, size: record.raw.size, dimensions: imageSize(head), source, answerable, reason,
    });
    return { type: 'text', content, name: record.stat.name };
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
