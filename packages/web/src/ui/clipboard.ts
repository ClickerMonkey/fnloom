/** Copying text to the clipboard: the async Clipboard API, or a hidden textarea where it isn't allowed (plain http). */

/** Copy `text`; resolves whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && window.isSecureContext && 'clipboard' in navigator) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea, which works without the permission
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only way to copy outside a secure context (plain http on the LAN)
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
