/**
 * Draws a markdown tree as Vue elements. Links open outside the app in a new tab; links inside it (`/…`, `#…`) and
 * resource URIs (`fs://…`, in a link or as a code span) go to `navigate` when given, so the app's router or resource
 * viewer handles them. Images open in `view` when given; one `held` (from outside the hub) is a placeholder until clicked. Code blocks are `UiCodeBlock`s; tables scroll inside their
 * own box.
 */
import { h, type VNode, type VNodeArrayChildren } from 'vue';
import UiCodeBlock from '../UiCodeBlock.vue';
import UiDiagram from '../UiDiagram.vue';
import type { MdBlock, MdInline } from './ast.ts';
import { DIAGRAM_LANGUAGES } from './diagram.ts';
import { RESOURCE_LINK } from '@harness/sdk';
import { mathAttrs, texToMath, type MathNode } from './math.ts';

/** A MathML tree as elements (Vue puts children of `math` in the MathML namespace). */
function mathNodes(nodes: readonly MathNode[]): VNode[] {
  return nodes.map((node) => ('text' in node ? h(node.tag, mathAttrs(node), node.text) : h(node.tag, mathAttrs(node), mathNodes(node.children))));
}

/** A TeX formula as a `math` element; its source is its accessible label and what copying it gives. */
function math(tex: string, display: boolean): VNode {
  return h('math', { class: display ? 'md-math-block' : 'md-math', display: display ? 'block' : 'inline', 'aria-label': tex, 'data-tex': tex }, mathNodes(texToMath(tex, display)));
}

/** What rendering needs from its host. */
export interface RenderHooks {
  /** Handle a link inside the app; without it such links load normally. */
  readonly navigate: ((href: string) => void) | undefined;
  /** Told whether copying a code block worked. */
  readonly copied: (ok: boolean) => void;
  /** Show an image large; without it images only draw inline. */
  readonly view?: ((src: string, alt: string) => void) | undefined;
  /**
   * The host of an image that waits for a click before it loads (one from outside the hub, while the admin's setting
   * asks first), else `undefined`; without it every image loads.
   */
  readonly held?: ((src: string) => string | undefined) | undefined;
  /** Load a held image (its placeholder was clicked). */
  readonly release?: ((src: string) => void) | undefined;
  /** Draw a cite's marker (its index among the message's cites); without it, or when it draws nothing, the marker is left out. */
  readonly cite?: ((index: number) => VNode | undefined) | undefined;
}

/** An image, or a placeholder that loads it when clicked while it is held. Images never send a referrer. */
function image(src: string, alt: string, hooks: RenderHooks): VNode {
  const host = hooks.held?.(src);
  if (host !== undefined) {
    return h('button', {
      type: 'button', class: 'md-image-held', 'data-testid': 'md-image-held', title: src,
      onClick: () => { hooks.release?.(src); },
    }, [h('span', { class: 'md-image-held-label' }, `Load image from ${host}`), ...(alt === '' ? [] : [h('span', { class: 'md-image-held-alt' }, alt)])]);
  }
  const img = h('img', { src, alt, loading: 'lazy', referrerpolicy: 'no-referrer', class: 'md-image' });
  const view = hooks.view;
  return view === undefined ? img : h('button', { type: 'button', class: 'md-image-open', 'aria-label': alt === '' ? 'Open image' : `Open image: ${alt}`, onClick: () => { view(src, alt); } }, [img]);
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
      case 'cite': return hooks.cite?.(node.index) ?? '';
      case 'math': return math(node.tex, false);
      case 'image': return image(node.src, node.alt, hooks);
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
    case 'code': return DIAGRAM_LANGUAGES.includes(node.lang) && !node.open
      ? h(UiDiagram, { source: node.text, language: node.lang, class: 'md-block' })
      : h(UiCodeBlock, { code: node.text, language: node.lang, class: 'md-block', onCopied: hooks.copied });
    case 'math': return h('div', { class: 'md-block md-math-wrap', tabindex: 0, role: 'region', 'aria-label': 'Formula' }, [math(node.tex, true)]);
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
