/**
 * Resources shown to the model in a conversation, made for the model each call is sent to.
 *
 * A conversation keeps a resource the model is shown by reference, never its bytes: `hub/resource_send` adds a
 * `<shown uri="…">` message after its reply (`shownMessage`), and an attached file is a `<file … uri="…">` tag in the
 * person's message (`files.ts`). Before each call (`ConversationMedia.expand`), a shown resource becomes its content
 * for the model chosen (`MessageContent.parts`): a picture for a model that sees, else an `<image id="…">` block it can
 * ask about with `hub/image_read`; and for a model that can't see, an attached picture's `<file>` tag becomes that
 * block too, and an image part already in a message becomes a short block saying it can't be shown. Since only the
 * references are kept, undo cuts them with the rest of a turn, and a chat that changes model reads every earlier image
 * the way its new model takes them.
 *
 * Every image part goes through one last check before a call (`pictureParts`): one that isn't a real picture of a
 * kind providers take (an empty data URL, text marked as a picture) becomes a short text note saying so. A provider
 * refuses the whole request over one bad picture, and the conversation is sent again every turn, so a bad part left
 * in would stop the chat for good.
 */
import { imagePartProblem, namesModel, type LlmContentPart, type LlmMessage, type ModelInfo, type ResourceUri, type SectionKey } from '@harness/core';
import { AUTO_MODEL } from '../contextor/limits.ts';
import { SHOWN_TAG } from '../contextor/render.ts';
import type { Asking, ContentModel, MessageContent } from '../resources/index.ts';
import { escapeAttribute } from './support.ts';

/** Where an image shown by `hub/resource_send` came from, as its block says. */
export const SHOWN_SOURCE = 'shown by hub/resource_send';
/** Where an attached image came from, as its block says. */
export const ATTACHED_SOURCE = 'attached to a message';
/** Where an image part already in a message came from. */
const EARLIER_SOURCE = 'earlier in this conversation';

/** The fn whose done runs show the model a resource. */
export const SEND_FN = 'hub/resource_send';

/** A model known to take only text (an automatic choice, or one no provider lists). */
const TEXT_ONLY: ContentModel = { id: 'text', capabilities: ['chat'] };

/** The message added after a call that showed the model a resource: the reference the next calls expand. */
export function shownMessage(uri: string, section?: string): LlmMessage {
  const attrs = `uri="${escapeAttribute(uri)}"${section === undefined ? '' : ` section="${escapeAttribute(section)}"`}`;
  return { role: 'user', content: `<${SHOWN_TAG} ${attrs}>The resource you asked to see with ${SEND_FN}.</${SHOWN_TAG}>` };
}

/** An attribute's text as it was before it was escaped. */
function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The reference a `shownMessage` holds, or undefined for any other text. */
export function parseShown(text: string): { uri: ResourceUri; section?: SectionKey } | undefined {
  const match = new RegExp(`^<${SHOWN_TAG} uri="([^"]*)"(?: section="([^"]*)")?>`).exec(text);
  if (match?.[1] === undefined) return undefined;
  const uri = unescape(match[1]) as ResourceUri;
  return match[2] === undefined ? { uri } : { uri, section: unescape(match[2]) as SectionKey };
}

/** An attached picture's `<file>` tag as `fileTag` writes it (one with a `uri`, so the hub kept it). */
const IMAGE_FILE = /<file name="[^"]*" mime="image\/[^"]*" size="\d+" uri="([^"]*)" read="[^"]*"(?: truncated="true")? \/>/g;

/** What a conversation's media needs. */
export interface ConversationMediaDeps {
  readonly content: () => Pick<MessageContent, 'parts'>;
  /** The models providers offer now, for what the chosen one takes. */
  readonly models: () => Promise<ReadonlyArray<Pick<ModelInfo, 'id' | 'provider' | 'capabilities'>>>;
  /** The most characters of a shown resource's text (a long one says how to read on). */
  readonly maxChars: number;
}

/** A conversation's shown resources, made for the model a call goes to. */
export class ConversationMedia {
  readonly #deps: ConversationMediaDeps;

  constructor(deps: ConversationMediaDeps) {
    this.#deps = deps;
  }

  /** What a model takes: its capabilities as its provider lists them; only text for an automatic choice or an unknown one. */
  async model(model: string): Promise<ContentModel> {
    if (model === AUTO_MODEL) return TEXT_ONLY;
    const found = (await this.#deps.models()).find((offered) => namesModel(model, offered));
    return found === undefined ? { ...TEXT_ONLY, id: model } : { id: found.id, capabilities: found.capabilities };
  }

  /** The messages as `model` takes them: shown resources expanded, and images it can't see as blocks. Unchanged otherwise. */
  async expand(messages: readonly LlmMessage[], model: string, who: Asking): Promise<LlmMessage[]> {
    if (!messages.some((message) => message.role === 'user' || message.role === 'tool')) return [...messages];
    const chosen = await this.model(model);
    const sees = chosen.capabilities.includes('vision');
    return pictureParts(await Promise.all(messages.map(async (message) => {
      if (message.role !== 'user' && message.role !== 'tool') return message;
      if (typeof message.content === 'string') {
        const shown = message.role === 'user' ? parseShown(message.content) : undefined;
        if (shown !== undefined) return { ...message, content: [{ type: 'text', content: message.content }, ...await this.#shown(shown, chosen, who)] };
        return sees || message.role !== 'user' ? message : { ...message, content: await this.#attached(message.content, chosen, who) };
      }
      if (sees) return message;
      return { ...message, content: message.content.map((part) => (part.type === 'image' ? unseenPart(part) : part)) };
    })));
  }

  /** A shown resource's parts for the model, its text kept to `maxChars`. */
  async #shown(shown: { uri: ResourceUri; section?: SectionKey }, model: ContentModel, who: Asking): Promise<LlmContentPart[]> {
    const parts = await this.#deps.content().parts(shown.uri, model, who, { ...(shown.section === undefined ? {} : { section: shown.section }), source: SHOWN_SOURCE });
    const max = this.#deps.maxChars;
    // an image's block is whole always: only a resource's text is cut
    return parts.map((part) => (part.type !== 'text' || part.content.length <= max || part.content.startsWith('<image ') ? part : {
      ...part, content: `${part.content.slice(0, max)}\n\n[cut after ${max} of ${part.content.length} characters: read the rest with hub/resource_read, by section or from offset ${max}]`,
    }));
  }

  /** A person's message with each attached picture's `<file>` tag as the block a model that can't see reads. */
  async #attached(text: string, model: ContentModel, who: Asking): Promise<string> {
    const tags = [...text.matchAll(IMAGE_FILE)];
    if (tags.length === 0) return text;
    const blocks = await Promise.all(tags.map(async (tag) => {
      const parts = await this.#deps.content().parts(unescape(tag[1] ?? '') as ResourceUri, model, who, { source: ATTACHED_SOURCE });
      return parts.map((part) => part.content).join('\n');
    }));
    let at = 0;
    let out = '';
    for (const [i, tag] of tags.entries()) {
      out += text.slice(at, tag.index) + (blocks[i] ?? tag[0]);
      at = tag.index + tag[0].length;
    }
    return out + text.slice(at);
  }
}

/**
 * Messages with every image part that can't go to a provider as a picture (`imagePartProblem`) replaced by a short
 * text note the model can read. For the request only: what is stored is never rewritten. Unchanged messages are the
 * same objects, and a conversation with nothing to replace comes back as the same array.
 */
export function pictureParts<M extends LlmMessage>(messages: M[]): M[] {
  let changed = false;
  const out = messages.map((message) => {
    if (typeof message.content === 'string' || !message.content.some((part) => part.type === 'image')) return message;
    let replaced = false;
    const content = message.content.map((part) => {
      if (part.type !== 'image') return part;
      const problem = imagePartProblem(part.content);
      if (problem === undefined) return part;
      replaced = true;
      const name = part.name ?? 'a picture';
      return { type: 'text' as const, content: `[${name} can't be shown to you as a picture: ${problem}. It was left out; don't guess what it shows.]`, ...(part.name === undefined ? {} : { name: part.name }) };
    });
    if (!replaced) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}

/** An image part a model that can't see would get, as a short block: it has no id, so nothing can be asked about it. */
function unseenPart(part: LlmContentPart): LlmContentPart {
  const name = part.name === undefined ? '' : ` name="${escapeAttribute(part.name)}"`;
  const mime = part.format === undefined ? '' : ` mime="${escapeAttribute(part.format)}"`;
  return { type: 'text', content: `<image${name}${mime} source="${EARLIER_SOURCE}">You can't see images here, and this one has no id to ask about it with.</image>`, ...(part.name === undefined ? {} : { name: part.name }) };
}
