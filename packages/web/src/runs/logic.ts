/**
 * A person's run page (`/run/:run`): what it may offer, worked out from the run's record. A run outside any chat (a
 * hub MCP call, a run a system started for its owner) is undone here, as a whole turn, by the person it ran for; a run
 * in a chat is undone there, where the turns after it are. The tree under it is its own branch of its turn's tree, and
 * the pages it relates to are its chat, the run that called it, and the second link of the notification that led here
 * (`also`, carried in the page's URL so a refresh keeps it).
 */
import { isSettled, NotificationAlso, type ActorId, type Run, type RunId, type TreeNode } from '@harness/core';
import type { RouteLocationRaw } from 'vue-router';
import type { IconName } from '../ui/index.ts';

/** The run's own branch of its turn's tree, or undefined when the tree doesn't hold it. */
export function branchOf(tree: TreeNode | undefined, run: RunId): TreeNode | undefined {
  if (tree === undefined) { return undefined; }
  if (tree.run.id === run) { return tree; }
  for (const child of tree.children) {
    const found = branchOf(child, run);
    if (found !== undefined) { return found; }
  }
  return undefined;
}

/** Whether a branch has anything under it worth drawing as a tree: runs it called, or model calls it made. */
export function hasBranch(node: TreeNode | undefined): boolean {
  return node !== undefined && (node.children.length > 0 || node.llmCalls.length > 0);
}

/**
 * Whether the page offers Undo: the run is the first of a turn outside any chat, it has ended and wasn't undone, and
 * it ran for the person looking (the hub undoes a turn outside a chat only for its own person). Undo takes back the
 * whole turn: this run and everything it called.
 */
export function canUndo(run: Pick<Run, 'id' | 'root' | 'parent' | 'session' | 'status' | 'actor'>, me: ActorId | undefined): boolean {
  return run.parent === undefined && run.root === run.id && run.session === undefined && isSettled(run.status) && run.status !== 'undone' && me !== undefined && run.actor === me;
}

/** Whether the page keeps asking for the run: while it hasn't ended, or while its approval waits. */
export function isLive(run: Pick<Run, 'status'> | undefined): boolean {
  return run !== undefined && !isSettled(run.status);
}

/** A notification's second link as the run page's URL carries it (`?also=`). */
export function alsoParam(also: NotificationAlso): string {
  return JSON.stringify(also);
}

/** The second link the URL carries, when it reads as one; anything else is left out. */
export function alsoOf(text: string): NotificationAlso | undefined {
  if (text === '') { return undefined; }
  try {
    const parsed = NotificationAlso.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A page the run relates to, as a button. */
export interface RelatedLink {
  readonly key: string;
  readonly label: string;
  readonly icon: IconName;
  readonly to: RouteLocationRaw;
}

/** How to reach the pages a run relates to. */
export interface RelatedRoutes {
  readonly session: (session: NonNullable<Run['session']>) => RouteLocationRaw;
  readonly run: (run: RunId) => RouteLocationRaw;
  /** Admin › Runs with the run open, for admins. */
  readonly admin: (run: RunId) => RouteLocationRaw;
}

/**
 * The pages a run relates to, in the order shown: the notification's second link (where it was resolved to), the
 * chat it ran in, the run that called it, and, for admins, the run in Admin › Runs.
 */
export function relatedLinks(
  run: Pick<Run, 'id' | 'session' | 'parent'>, routes: RelatedRoutes, options: { readonly also?: { readonly label: string; readonly to: RouteLocationRaw } | undefined; readonly admin: boolean },
): RelatedLink[] {
  return [
    ...(options.also === undefined ? [] : [{ key: 'also', label: options.also.label, icon: 'arrow-right' as const, to: options.also.to }]),
    ...(run.session === undefined ? [] : [{ key: 'chat', label: 'Open the chat', icon: 'chat' as const, to: routes.session(run.session) }]),
    ...(run.parent === undefined ? [] : [{ key: 'parent', label: 'Called by', icon: 'chevron-left' as const, to: routes.run(run.parent) }]),
    ...(options.admin ? [{ key: 'admin', label: 'In Admin › Runs', icon: 'fn' as const, to: routes.admin(run.id) }] : []),
  ];
}

/** What the toast says after an undo. */
export function undoSummary(report: { readonly undone: readonly unknown[]; readonly failed: readonly unknown[]; readonly notUndoable: readonly unknown[] }): { tone: 'ok' | 'warn'; body: string } {
  const parts = [
    report.undone.length === 0 ? 'Nothing needed undoing' : `${report.undone.length} undone`,
    ...(report.failed.length === 0 ? [] : [`${report.failed.length} couldn't be undone`]),
    ...(report.notUndoable.length === 0 ? [] : [`${report.notUndoable.length} have no undo`]),
  ];
  return { tone: report.failed.length > 0 ? 'warn' : 'ok', body: `${parts.join(', ')}.` };
}
