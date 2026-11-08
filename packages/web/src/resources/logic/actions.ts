/**
 * What can be done with a resource in the browser, by what it is: open it, download it, copy its address, make
 * context from it, make the forms its family can have (describe or read the text in an image, transcribe audio and
 * video, convert a document or a table), fetch a page imported from the web again, and, for hub resources only, rename
 * and delete it. The same list drives a
 * row's menu and the bulk bar (which offers what every selected resource allows). Pure, so it is tested alone.
 */
import { FormKind, type ResourceRecord } from '@harness/core';
import type { IconName } from '../../ui/index.ts';
import { isHubResource } from './browse.ts';
import { FORM_LABEL, familyOfStat } from './formats.ts';

/** An action on resources. Making a form is `make:<kind>`. */
export type ResourceAction = 'open' | 'download' | 'copy' | 'context' | 'refetch' | 'rename' | 'delete' | `make:${FormKind}`;

/** What the actions read of a resource. */
export type ActionTarget = Pick<ResourceRecord, 'uri' | 'stat' | 'forms' | 'source'>;

/** The address a resource was imported from, when it came from the web (so it can be fetched again). */
export function webAddress(record: Pick<ResourceRecord, 'source'>): string | undefined {
  return record.source?.from === 'web' ? record.source.url : undefined;
}

/** One action as a menu shows it. */
export interface ActionItem {
  readonly value: ResourceAction;
  readonly label: string;
  readonly icon: IconName;
  readonly danger?: boolean;
  /** Works on many resources at once (the bulk bar). */
  readonly bulk: boolean;
}

/** The forms each family can be asked to make, beyond what conversion makes on its own. */
const MAKEABLE: Readonly<Partial<Record<ReturnType<typeof familyOfStat>, readonly FormKind[]>>> = {
  image: ['description', 'ocr'],
  audio: ['transcript'],
  video: ['transcript'],
  document: ['markdown'],
  web: ['markdown'],
  table: ['table'],
};

/** The words for making a form. */
const MAKE_LABEL: Readonly<Partial<Record<FormKind, string>>> = { description: 'Describe', ocr: 'Read the text in it', transcript: 'Transcribe', markdown: 'Convert to markdown', table: 'Read its tables' };

/** The actions a resource allows, in menu order. Forms it already has aren't offered again. */
export function actionsFor(record: ActionTarget): ActionItem[] {
  const made = new Set(record.forms ?? []);
  const makes = (MAKEABLE[familyOfStat(record.stat)] ?? []).filter((kind) => !made.has(kind)).map((kind): ActionItem => ({
    value: `make:${kind}`, label: MAKE_LABEL[kind] ?? `Make ${FORM_LABEL[kind].toLowerCase()}`, icon: 'sparkles', bulk: true,
  }));
  const hub = isHubResource(record.uri);
  return [
    { value: 'open', label: 'Open', icon: 'eye', bulk: false },
    { value: 'download', label: 'Download', icon: 'download', bulk: false },
    { value: 'copy', label: 'Copy address', icon: 'copy', bulk: false },
    { value: 'context', label: 'Make context', icon: 'book-open', bulk: true },
    ...makes,
    ...(webAddress(record) === undefined ? [] : [{ value: 'refetch', label: 'Fetch again', icon: 'refresh', bulk: true } satisfies ActionItem]),
    ...(hub ? [{ value: 'rename', label: 'Rename', icon: 'edit', bulk: false } satisfies ActionItem, { value: 'delete', label: 'Delete', icon: 'trash', danger: true, bulk: true } satisfies ActionItem] : []),
  ];
}

/** What "Make context" asks before it acts: what it makes from which resources, and the button's words. */
export function contextConfirm(names: readonly string[]): { readonly title: string; readonly body: string; readonly confirm: string } {
  const [only] = names;
  const what = names.length === 1 && only !== undefined ? only : `these ${names.length} resources`;
  return {
    title: names.length === 1 ? 'Make context from this?' : `Make context from ${names.length} resources?`,
    body: `This adds ${what} to the context library, one item per section, so the agent can be given it in chats. Running it again updates those items.`,
    confirm: 'Make context',
  };
}

/** The actions every one of several resources allows, for the bulk bar. */
export function bulkActions(records: readonly ActionTarget[]): ActionItem[] {
  if (records.length === 0) { return []; }
  const [first, ...rest] = records.map((r) => actionsFor(r).filter((a) => a.bulk));
  return (first ?? []).filter((action) => rest.every((list) => list.some((a) => a.value === action.value)));
}

/** Whether an action makes a form. */
export function isMake(action: ResourceAction): action is `make:${FormKind}` {
  return madeBy(action) !== undefined;
}

/** The form an action makes, if it makes one. */
export function madeBy(action: ResourceAction): FormKind | undefined {
  const parsed = FormKind.safeParse(/^make:(.+)$/.exec(action)?.[1]);
  return parsed.success ? parsed.data : undefined;
}
