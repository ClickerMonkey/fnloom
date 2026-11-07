import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ref } from 'vue';
import UiAvatar from './UiAvatar.vue';
import UiBadge from './UiBadge.vue';
import UiButton from './UiButton.vue';
import UiCodeBlock from './UiCodeBlock.vue';
import UiDialog from './UiDialog.vue';
import UiIconButton from './UiIconButton.vue';
import UiInput from './UiInput.vue';
import UiMenu from './UiMenu.vue';
import UiPopover from './UiPopover.vue';
import UiSegmented from './UiSegmented.vue';
import UiSwitch from './UiSwitch.vue';
import UiTabs from './UiTabs.vue';
import UiTextarea from './UiTextarea.vue';
import UiToaster from './UiToaster.vue';
import UiMarkdown from './markdown/UiMarkdown.vue';
import type { MenuItem } from './types.ts';

afterEach(() => { document.body.innerHTML = ''; });

const key = (el: Element, k: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };

describe('UiButton', () => {
  it('emits clicks, and while loading is busy and refuses them', async () => {
    const button = mount(UiButton, { props: { variant: 'primary', icon: 'plus' }, slots: { default: 'Add' } });
    await button.trigger('click');
    expect(button.emitted('click')).toHaveLength(1);
    expect(button.text()).toBe('Add');
    await button.setProps({ loading: true });
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.find('[role="status"]').exists()).toBe(true);
  });
});

describe('UiIconButton', () => {
  it('is named by its label, shows a capped count or a dot, and toggles aria-pressed', async () => {
    const button = mount(UiIconButton, { props: { icon: 'bell', label: 'Notifications', badge: 120 } });
    expect(button.attributes('aria-label')).toBe('Notifications');
    expect(button.find('.count').text()).toBe('99+');
    expect(button.attributes('aria-pressed')).toBeUndefined();
    await button.setProps({ badge: true, pressed: true });
    expect(button.find('.dot').exists()).toBe(true);
    expect(button.attributes('aria-pressed')).toBe('true');
    await button.setProps({ badge: 0 });
    expect(button.find('.badge').exists()).toBe(false);
  });
});

describe('UiInput and UiTextarea', () => {
  it('ties the label, hint and error to the input, and clears', async () => {
    const value = ref('hello');
    const input = mount(UiInput, { props: { label: 'Name', hint: 'Shown to others', clearable: true, modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v; } } });
    const el = input.get('input');
    expect(input.get('label').attributes('for')).toBe(el.attributes('id'));
    expect(el.attributes('aria-describedby')).toContain('hint');
    await el.setValue('Ada');
    expect(value.value).toBe('Ada');
    await input.setProps({ modelValue: 'Ada', error: 'Too short' });
    expect(el.attributes('aria-invalid')).toBe('true');
    expect(input.get('[role="alert"]').text()).toBe('Too short');
    await input.get('button[aria-label="Clear"]').trigger('click');
    expect(value.value).toBe('');
    await el.trigger('keydown', { key: 'Enter' });
    expect(input.emitted('enter')).toHaveLength(1);
  });

  it('binds a textarea', async () => {
    const value = ref('');
    const area = mount(UiTextarea, { props: { label: 'Notes', modelValue: '', 'onUpdate:modelValue': (v: string) => { value.value = v; } } });
    await area.get('textarea').setValue('line one\nline two');
    expect(value.value).toBe('line one\nline two');
  });
});

describe('choices', () => {
  it('UiSegmented chooses by click and arrow keys', async () => {
    const value = ref('a');
    const group = mount(UiSegmented, {
      attachTo: document.body,
      props: { label: 'Pick', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v; } },
    });
    const radios = group.findAll('[role="radio"]');
    await radios[2]?.trigger('click');
    expect(value.value).toBe('c');
    await group.setProps({ modelValue: 'c' });
    key(radios[2]?.element ?? document.body, 'ArrowRight');
    expect(value.value).toBe('a');
    expect(document.activeElement).toBe(radios[0]?.element);
    group.unmount();
  });

  it('UiSwitch flips and says its state', async () => {
    const value = ref(false);
    const toggle = mount(UiSwitch, { props: { label: 'Notify', modelValue: false, 'onUpdate:modelValue': (v: boolean) => { value.value = v; } } });
    expect(toggle.get('[role="switch"]').attributes('aria-checked')).toBe('false');
    await toggle.get('[role="switch"]').trigger('click');
    expect(value.value).toBe(true);
  });

  it('UiTabs moves with arrow keys and renders the chosen panel', async () => {
    const value = ref('one');
    const tabs = mount(UiTabs, {
      attachTo: document.body,
      props: { label: 'Sections', tabs: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two', count: 3 }], modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v; } },
      slots: { default: ({ value: shown }: { value: string }) => h('p', { class: 'panel-text' }, `panel ${shown}`) },
    });
    expect(tabs.get('.panel-text').text()).toBe('panel one');
    expect(tabs.get('.count').text()).toBe('3');
    key(tabs.findAll('[role="tab"]')[0]?.element ?? document.body, 'ArrowRight');
    expect(value.value).toBe('two');
    await tabs.setProps({ modelValue: 'two' });
    expect(tabs.findAll('[role="tab"]')[1]?.attributes('aria-selected')).toBe('true');
    tabs.unmount();
  });
});

describe('UiMenu', () => {
  type Action = 'rename' | 'archive' | 'delete';
  const ITEMS: readonly MenuItem<Action>[] = [
    { value: 'rename', label: 'Rename' },
    { value: 'archive', label: 'Archive', disabled: true },
    { kind: 'separator' },
    { value: 'delete', label: 'Delete', danger: true },
  ];
  const menu = () => mount(UiMenu, {
    attachTo: document.body,
    props: { items: ITEMS, label: 'Actions' },
    slots: { trigger: ({ toggle, attrs }: { toggle: () => void; attrs: Record<string, string> }) => h('button', { ...attrs, class: 'trigger', onClick: toggle }, 'Open') },
  });

  it('opens on click with focus on the first action, skips disabled ones, and chooses with a click', async () => {
    const host = menu();
    const trigger = host.get('.trigger');
    expect(trigger.attributes('aria-haspopup')).toBe('menu');
    await trigger.trigger('click');
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('true');
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((i) => i.textContent.trim())).toEqual(['Rename', 'Archive', 'Delete']);
    expect(document.activeElement).toBe(items[0]);
    key(items[0] ?? document.body, 'ArrowDown');
    expect(document.activeElement).toBe(items[2]);
    key(items[2] ?? document.body, 'r');
    expect(document.activeElement).toBe(items[0]);
    items[1]?.click();
    expect(host.emitted('select')).toBeUndefined();
    items[2]?.click();
    await flushPromises();
    expect(host.emitted('select')).toEqual([['delete']]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    host.unmount();
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    const host = menu();
    const trigger = host.get('.trigger');
    if (trigger.element instanceof HTMLElement) { trigger.element.focus(); }
    key(trigger.element, 'ArrowUp');
    await flushPromises();
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[2]);
    key(items[2] ?? document.body, 'Escape');
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    host.unmount();
  });
});

describe('overlays', () => {
  it('UiDialog moves focus in, keeps Tab inside, and closes on Escape and the backdrop', async () => {
    const open = ref(true);
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const dialog = mount(UiDialog, {
      attachTo: document.body,
      props: { title: 'Archive?', description: 'You can undo this.', open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v; } },
      slots: { default: '<input data-autofocus />', footer: '<button class="ok">OK</button>' },
    });
    await flushPromises();
    const panel = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(panel?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Archive?');
    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(document.documentElement.style.overflow).toBe('hidden');
    const ok = document.querySelector<HTMLElement>('.ok');
    ok?.focus();
    key(ok ?? document.body, 'Tab');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    key(document.body, 'Escape');
    expect(open.value).toBe(false);
    await dialog.setProps({ open: false });
    await flushPromises();
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.activeElement).toBe(opener);

    open.value = true;
    await dialog.setProps({ open: true });
    await flushPromises();
    document.querySelector('.backdrop')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(open.value).toBe(false);
    dialog.unmount();
  });

  it('UiPopover places itself next to its anchor and closes on a press outside', async () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const open = ref(true);
    const popover = mount(UiPopover, {
      attachTo: document.body,
      props: { anchor, label: 'Details', open: true, 'onUpdate:open': (v: boolean) => { open.value = v; } },
      slots: { default: '<p class="content">Hello</p>' },
    });
    await flushPromises();
    const panel = document.querySelector<HTMLElement>('.ui-popover');
    expect(panel?.getAttribute('aria-label')).toBe('Details');
    expect(panel?.style.maxWidth).toMatch(/px$/);
    anchor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(open.value).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(open.value).toBe(false);
    popover.unmount();
  });
});

describe('UiToaster', () => {
  it('draws toasts and reports dismiss, action, hold and release', async () => {
    const toaster = mount(UiToaster, { attachTo: document.body, props: { toasts: [{ id: 1, tone: 'danger', title: 'Failed', body: 'Try again', action: 'Retry' }] } });
    const toast = document.querySelector<HTMLElement>('.toast');
    expect(toast?.getAttribute('role')).toBe('alert');
    toast?.dispatchEvent(new PointerEvent('pointerenter'));
    toast?.dispatchEvent(new PointerEvent('pointerleave'));
    document.querySelector<HTMLElement>('.action')?.click();
    document.querySelector<HTMLElement>('[aria-label="Dismiss"]')?.click();
    await nextTick();
    expect(toaster.emitted('hold')).toEqual([[1]]);
    expect(toaster.emitted('release')).toEqual([[1]]);
    expect(toaster.emitted('action')).toEqual([[1]]);
    expect(toaster.emitted('dismiss')).toEqual([[1]]);
    toaster.unmount();
  });
});

describe('UiCodeBlock', () => {
  it('copies its code, confirms, and toggles wrapping', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const block = mount(UiCodeBlock, { props: { code: 'const a = 1;\nconst b = 2;\n', language: 'ts', lineNumbers: true } });
    expect(block.get('.caption').text()).toBe('ts');
    expect(block.findAll('.line')).toHaveLength(2);
    await block.get('[aria-label="Copy code"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;\n');
    expect(block.emitted('copied')).toEqual([[true]]);
    expect(block.find('[aria-label="Copied"]').exists()).toBe(true);
    await block.get('[aria-label="Wrap long lines"]').trigger('click');
    expect(block.classes()).toContain('wrapped');
  });
});

describe('UiMarkdown', () => {
  it('renders markdown as elements, never as HTML from the source', () => {
    const md = mount(UiMarkdown, { props: { source: '# Hi\n\n<img src=x onerror=alert(1)> **bold** [out](https://example.com) [in](/chat)\n\n```js\nlet a\n```' } });
    expect(md.find('h1').text()).toBe('Hi');
    expect(md.find('img').exists()).toBe(false);
    expect(md.text()).toContain('<img src=x onerror=alert(1)>');
    expect(md.find('strong').text()).toBe('bold');
    const [out, inside] = md.findAll('a');
    expect(out?.attributes()).toMatchObject({ href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer' });
    expect(inside?.attributes('target')).toBeUndefined();
    expect(md.get('.ui-code pre').text()).toBe('let a');
    expect(md.get('.ui-code .caption').text()).toBe('js');
  });

  it('hands links inside the app to navigate', async () => {
    const navigate = vi.fn();
    const md = mount(UiMarkdown, { props: { source: '[session](/chat/ses_1) and [site](https://x.dev)', navigate } });
    await md.findAll('a')[0]?.trigger('click');
    expect(navigate).toHaveBeenCalledWith('/chat/ses_1');
    await md.findAll('a')[1]?.trigger('click');
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('draws tasks and tables', () => {
    const md = mount(UiMarkdown, { props: { source: '- [x] done\n\n| a | b |\n|--|--:|\n| 1 | 2 |' } });
    expect(md.get('input[type="checkbox"]').attributes('checked')).toBeDefined();
    expect(md.get('.md-table').attributes('role')).toBe('region');
    expect(md.findAll('td')[1]?.attributes('style')).toContain('text-align: right');
  });
});

describe('display', () => {
  it('UiAvatar shows initials, or the agent mark, and names its presence', () => {
    const person = mount(UiAvatar, { props: { name: 'Ada Lovelace', presence: 'online' } });
    expect(person.text()).toBe('AL');
    expect(person.attributes('aria-label')).toBe('Ada Lovelace, online');
    const agent = mount(UiAvatar, { props: { name: 'Chat agent', kind: 'agent' } });
    expect(agent.find('svg').exists()).toBe(true);
  });

  it('UiBadge takes a tone and a live dot', () => {
    const badge = mount(UiBadge, { props: { tone: 'ok', dot: true, live: true }, slots: { default: 'Running' } });
    expect(badge.classes()).toContain('tone-ok');
    expect(badge.find('.dot.live').exists()).toBe(true);
  });
});
