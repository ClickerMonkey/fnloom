/**
 * The markdown tree the parser makes and the renderer draws. Rendering builds elements from this tree, never from
 * HTML text, so nothing in a message can inject markup; links and images keep only safe URLs.
 */

/** A run of text inside a block. */
export type MdInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'strong'; readonly children: readonly MdInline[] }
  | { readonly type: 'em'; readonly children: readonly MdInline[] }
  | { readonly type: 'del'; readonly children: readonly MdInline[] }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly MdInline[] }
  | { readonly type: 'image'; readonly src: string; readonly alt: string }
  | { readonly type: 'break' };

/** How a table column lines up. */
export type MdAlign = 'left' | 'center' | 'right' | null;

/** One item of a list; `checked` is set for task items (`- [x]`). */
export interface MdListItem {
  readonly checked: boolean | undefined;
  readonly children: readonly MdBlock[];
}

/** A block of a document. */
export type MdBlock =
  | { readonly type: 'paragraph'; readonly children: readonly MdInline[] }
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly MdInline[] }
  /** `open` while the closing fence hasn't arrived yet (streaming). */
  | { readonly type: 'code'; readonly lang: string; readonly text: string; readonly open: boolean }
  | { readonly type: 'quote'; readonly children: readonly MdBlock[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly MdListItem[] }
  | { readonly type: 'table'; readonly align: readonly MdAlign[]; readonly head: readonly (readonly MdInline[])[]; readonly rows: readonly (readonly (readonly MdInline[])[])[] }
  | { readonly type: 'rule' };
