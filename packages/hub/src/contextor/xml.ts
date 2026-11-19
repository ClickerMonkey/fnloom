/**
 * The one XML the model reads fns and context in. Every fn card it sees (a suggestion, a loaded fn in the static
 * toolset, `inspect`, a `<more_fns>` entry, the fns a tool reply exposes, an invalid call's reply) is a `<fn>` element,
 * and every context card (a suggestion, a loaded block, a `<more_context>` entry) a `<context>` element, so it is
 * always clear where one thing ends and the next begins. An element's text comes first, then its parts as child
 * elements. Attribute values and text are escaped; only elements made here go into a body as they are.
 */
import type { FnExample, FnMode } from '@harness/core';
import { escapeAttribute, escapeBody } from '../chat/support.ts';

/** An element made here: a body takes it as it is, where a plain string is text and is escaped. */
class Markup {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  toString(): string {
    return this.#text;
  }
}

export type { Markup };

/** An element's attributes, in the order written; undefined ones are left out. */
export type XmlAttributes = Readonly<Record<string, string | number | undefined>>;
/** A piece of a body: text (escaped), an element, or nothing (left out, as is empty text). */
export type XmlChild = string | Markup | undefined;

/** Whether a body piece is an element made here. */
function isMarkup(child: XmlChild): child is Markup {
  return child instanceof Markup;
}

/**
 * An element. Without a body it closes itself; a body of one line of text stays on its line; anything else puts each
 * piece on its own lines between the tags.
 */
export function element(tag: string, attributes: XmlAttributes = {}, children: readonly XmlChild[] = []): Markup {
  const attrs = Object.entries(attributes).map(([name, value]) => (value === undefined ? '' : ` ${name}="${escapeAttribute(String(value))}"`)).join('');
  const body = children.flatMap((child): Array<{ readonly text: string; readonly inline: boolean }> => {
    if (child === undefined) return [];
    if (isMarkup(child)) return [{ text: child.toString(), inline: false }];
    const text = escapeBody(child.trim());
    return text === '' ? [] : [{ text, inline: !text.includes('\n') }];
  });
  const [only] = body;
  if (only === undefined) return new Markup(`<${tag}${attrs} />`);
  if (body.length === 1 && only.inline) return new Markup(`<${tag}${attrs}>${only.text}</${tag}>`);
  return new Markup(`<${tag}${attrs}>\n${body.map((piece) => piece.text).join('\n')}\n</${tag}>`);
}

/** Elements one per line, under a tag, after a line saying what they are; empty without any. */
export function cardList(tag: string, intro: string, cards: readonly Markup[]): string {
  return cards.length === 0 ? '' : element(tag, {}, [intro, ...cards]).toString();
}

// ─── Fns ──────────────────────────────────────────────────────────────────────

/** What a `<fn>` card shows. What is absent is left off, so a card grows with the detail it is shown at. */
export interface FnCardParts {
  readonly name: string;
  /** Its label for people (`fnLabel`). */
  readonly label: string;
  /** What it does to data; absent where it isn't known (a suggestion written before cards were snapshotted). */
  readonly mode?: FnMode | undefined;
  /** What blocks it now, in the hub's words; absent when it can be used. */
  readonly blocked?: string | undefined;
  /** Its description (a listed card: its first line). */
  readonly description: string;
  /** The lines beside its description: its table routing, what it changes in the hub, its long-running warning. */
  readonly beside?: readonly string[];
  /** Its args and result in gin's code. */
  readonly args?: string | undefined;
  readonly returns?: string | undefined;
  readonly instructions?: string | undefined;
  readonly examples?: readonly FnExample[] | undefined;
  /** How many more examples it has than it shows. */
  readonly moreExamples?: number | undefined;
  /** The definitions of the named types it uses that the prompt hasn't shown yet. */
  readonly types?: ReadonlyArray<readonly [name: string, definition: string]>;
}

/** The `available` attribute's value: `yes`, or `no` with the reason beside it. */
export const AVAILABLE = { yes: 'yes', no: 'no' } as const;

/** An example as a card shows it: its args as JSON, then its result. */
function exampleElement(example: FnExample): Markup {
  const result = example.result === undefined ? '' : ` → ${JSON.stringify(example.result)}`;
  return element('example', { note: example.note }, [`${JSON.stringify(example.args)}${result}`]);
}

/** A fn's card. */
export function fnElement(card: FnCardParts): Markup {
  const moreExamples = card.moreExamples === undefined || card.moreExamples < 1 ? undefined
    : element('more_examples', { count: card.moreExamples }, [`Read them with hub/fn_examples ${JSON.stringify({ fn: card.name, query: 'what you are about to do' })}`]);
  return element('fn', {
    name: card.name, label: card.label, mode: card.mode, available: card.blocked === undefined ? AVAILABLE.yes : AVAILABLE.no, reason: card.blocked,
  }, [
    [card.description.trim(), ...(card.beside ?? [])].filter((line) => line !== '').join('\n'),
    card.args === undefined ? undefined : element('args', {}, [card.args]),
    card.returns === undefined ? undefined : element('returns', {}, [card.returns]),
    card.instructions === undefined || card.instructions.trim() === '' ? undefined : element('instructions', {}, [card.instructions]),
    ...(card.examples ?? []).map(exampleElement),
    moreExamples,
    ...(card.types ?? []).map(([name, definition]) => element('type', { name }, [definition])),
  ]);
}

// ─── Context ──────────────────────────────────────────────────────────────────

/** What a `<context>` card shows. */
export interface ContextCardParts {
  readonly key: string;
  /** What people call it, when it has a title of its own. */
  readonly title?: string | undefined;
  /** `summary` when the text is cut short (its summary, not its content). */
  readonly detail?: 'summary' | undefined;
  /** Its text at the detail shown: its first line, its summary or its content. */
  readonly text: string;
  /** Its parts after the text: the fns it brings, where to go next. */
  readonly parts?: readonly XmlChild[];
  /** More about how it got here, after its own attributes (a crawl's level, how it was reached, its size). */
  readonly about?: XmlAttributes;
}

/** A context item's card. */
export function contextElement(card: ContextCardParts): Markup {
  return element('context', { key: card.key, title: card.title, detail: card.detail, ...card.about }, [card.text, ...(card.parts ?? [])]);
}
