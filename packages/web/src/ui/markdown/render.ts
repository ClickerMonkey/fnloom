/**
 * Draws a markdown tree as Vue elements. Links open outside the app in a new tab; links inside it (`/…`, `#…`) go to
 * `navigate` when given, so the app's router handles them. Code blocks are `UiCodeBlock`s; tables scroll inside their
 * own box.
 */
import { h, type VNode, type VNodeArrayChildren } from 'vue';
import UiCodeBlock from '../UiCodeBlock.vue';
import type { MdBlock, MdInline } from './ast.ts';

/** What rendering needs from its host. */
export interface RenderHooks {
  /** Handle a link inside the app; without it such links load normally. */
  readonly navigate: ((href: string) => void) | undefined;
  /** Told whether copying a code block worked. */
  readonly copied: (ok: boolean) => void;
}

const isInternal = (href: string): boolean => href.startsWith('/') || href.startsWith('#') || href.startsWith('.');

function inline(nodes: readonly MdInline[], hooks: RenderHooks): VNodeArrayChildren {
  return nodes.map((node): VNode | string => {
    switch (node.type) {
      case 'text': return node.text;
      case 'strong': return h('strong', inline(node.children, hooks));
      case 'em': return h('em', inline(node.children, hooks));
      case 'del': return h('del', inline(node.children, hooks));
      case 'code': return h('code', { class: 'md-code' }, node.text);
      case 'break': return h('br');
      case 'image': return h('img', { src: node.src, alt: node.alt, loading: 'lazy', class: 'md-image' });
      case 'link': {
        const internal = isInternal(node.href);
        const navigate = hooks.navigate;
        return h('a', {
          href: node.href,
          ...(internal ? {} : { target: '_blank', rel: 'noopener noreferrer' }),
          onClick: internal && navigate ? (event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) { return; }
            event.preventDefault();
            navigate(node.href);
          } : undefined,
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
