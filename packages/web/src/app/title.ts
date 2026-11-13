/** The browser tab's title: how many things need you, the page, and the hub's display name. */
export function tabTitle(page: string, unread: number, hubName: string): string {
  const count = unread > 0 ? `(${unread > 99 ? '99+' : String(unread)}) ` : '';
  return page === hubName ? `${count}${hubName}` : `${count}${page} · ${hubName}`;
}
