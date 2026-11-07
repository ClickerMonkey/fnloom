/** Small DOM readers shared by the chat's components, so templates never reach for browser globals. */

/** The value of the input, select or textarea an event came from ('' for anything else). */
export function eventValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement ? target.value : '';
}

/** Whether this device's main pointer is a finger (Enter then breaks lines instead of sending). */
export function isTouch(win: Pick<Window, 'matchMedia'> = window): boolean {
  return win.matchMedia('(hover: none) and (pointer: coarse)').matches;
}
