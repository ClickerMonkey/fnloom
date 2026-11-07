/**
 * Draws a markdown tree as Vue elements. Links open outside the app in a new tab; links inside it (`/…`, `#…`) and
 * resource URIs (`fs://…`, in a link or as a code span) go to `navigate` when given, so the app's router or resource
 * viewer handles them. Images open in `view` when given. Code blocks are `UiCodeBlock`s; tables scroll inside their
 * own box.
 */
import { h, type VNode, type VNodeArrayChildren } from 'vue';
import UiCodeBlock from '../UiCodeBlock.vue';
import type { MdBlock, MdInline } from './ast.ts';
import { RESOURCE_LINK } from './inline.ts';

/** What rendering needs from its host. */
export interface RenderHooks {
  /** Handle a link inside the app; without it such links load normally. */
  readonly navigate: ((href: string) => void) | undefined;
  /** Told whether copying a code block worked. */
  readonly copied: (ok: boolean) => void;
  /** Show an image large; without it images only draw inline. */
  readonly view?: ((src: string, alt: string) => void) | undefined;
}

const isInternal = (href: string): boolean => href.startsWith('/') || href.startsWith('#') || href.startsWith('.') || RESOURCE_LINK.test(href);

/** A click that should go to `navigate` rather than the browser (a plain left click). */
function handled(navigate: ((href: string) => void) | undefined, href: string): ((event: MouseEvent) => void) | undefined {
  return navigate === undefined ? undefined : (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) { return; }
    event.preventDefault();
    navigate(href);
  };
}

function inline(nodes: readonly MdInline[], hooks: RenderHooks): VNodeArrayChildren {
  return nodes.map((node): VNode | string => {
    switch (node.type) {
      case 'text': return node.text;
      case 'strong': return h('strong', inline(node.children, hooks));
      case 'em': return h('em', inline(node.children, hooks));
      case 'del': return h('del', inline(node.children, hooks));
      case 'code': return RESOURCE_LINK.test(node.text) && hooks.navigate !== undefined
        ? h('a', { href: node.text, class: 'md-resource', onClick: handled(hooks.navigate, node.text) }, [h('code', { class: 'md-code' }, node.text)])
        : h('code', { class: 'md-code' }, node.text);
      case 'break': return h('br');
      case 'image': {
        const img = h('img', { src: node.src, alt: node.alt, loading: 'lazy', class: 'md-image' });
        const view = hooks.view;
        return view === undefined ? img : h('button', { type: 'button', class: 'md-image-open', 'aria-label': node.alt === '' ? 'Open image' : `Open image: ${node.alt}`, onClick: () => { view(node.src, node.alt); } }, [img]);
      }
      case 'link': {
        const internal = isInternal(node.href);
        return h('a', {
          href: node.href,
          ...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' }),
          onClick: internal ? handled(hooks.navigate, node.href) : undefined,
        }, inline(node.children, hooks));
      }
    }
  });
}

function block(node: MdBlock, hooks: RenderHooks): VNode {
  switch (node.type) {
    case 'paragraph': return h('p', inline(node.children, hooks));
    case 'heading': return h(`h${node.level}`, inline(node.children, hooks));
    case 'rule': return h('hr');
    case 'quote': return h('blockquote', renderBlocks(node.children, hooks));
    case 'code': return h(UiCodeBlock, { code: node.text, language: node.lang, class: 'md-block', onCopied: hooks.copied });
    case 'list': return h(node.ordered ? 'ol' : 'ul', {
      ...(node.ordered && node.start !== 1 ? { start: node.start } : {}),
      class: node.items.every((item) => item.checked !== undefined) ? 'md-tasks' : undefined,
    }, node.items.map((item) => h('li', { class: item.checked === undefined ? undefined : 'md-task' }, [
      ...(item.checked === undefined ? [] : [h('input', { type: 'checkbox', checked: item.checked, disabled: true, 'aria-label': item.checked ? 'Done' : 'Not done' })]),
      ...renderBlocks(item.children, hooks),
    ])));
    case 'table': return h('div', { class: 'md-table', tabindex: 0, role: 'region', 'aria-label': 'Table' }, [h('table', [
      h('thead', [h('tr', node.head.map((cell, i) => h('th', { style: node.align[i] ? { textAlign: node.align[i] } : undefined }, inline(cell, hooks))))]),
      h('tbody', node.rows.map((row) => h('tr', row.map((cell, i) => h('td', { style: node.align[i] ? { textAlign: node.align[i] } : undefined }, inline(cell, hooks)))))),
    ])]);
  }
}

/** Draw a markdown tree. */
export function renderBlocks(nodes: readonly MdBlock[], hooks: RenderHooks): VNode[] {
  return nodes.map((node) => block(node, hooks));
}
