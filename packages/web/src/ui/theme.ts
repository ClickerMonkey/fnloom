/**
 * The page's shown theme as the design system's components see it: the `data-theme` the app sets on `<html>`
 * (`light` or `dark`), followed live, so a component drawing outside CSS (a diagram, a canvas) redraws when it
 * changes. Without `data-theme`, the device's preference.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** Whether the page shows its dark theme now. */
export function isDark(doc: Document = document): boolean {
  const theme = doc.documentElement.dataset['theme'];
  if (theme === 'dark' || theme === 'light') { return theme === 'dark'; }
  return doc.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches === true;
}

/** Whether the page shows its dark theme, updated as the theme changes. */
export function useDarkTheme(): Readonly<Ref<boolean>> {
  const dark = ref(typeof document === 'undefined' ? false : isDark());
  let observer: MutationObserver | undefined;
  onMounted(() => {
    dark.value = isDark();
    observer = new MutationObserver(() => { dark.value = isDark(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });
  onBeforeUnmount(() => { observer?.disconnect(); });
  return dark;
}
