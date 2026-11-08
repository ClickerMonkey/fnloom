/**
 * What the e2e tests drive the hub with: a signed-in admin client for the hub under test, the session helpers the UI
 * test fixtures share (`scripts/session.ts`), and small helpers over the web API: running one fn by hand (`invoke`)
 * and waiting for it to settle, uploading bytes, and walking a turn's run tree.
 */
import { isSettled, type ContentRef, type Json, type QualifiedName, type Run, type RunId, type SessionId, type TreeNode } from '@harness/core';
import { inject } from 'vitest';
import { signIn, waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { clientInfo } from '../scripts/session.ts';
import { e2eEnv } from './env.ts';

export { Approver, ask, clientInfo, finished, SessionWatch, statusOf, textOf } from '../scripts/session.ts';

/** The e2e settings, parsed once. */
export const settings = e2eEnv.parse();

/** Sign in to the hub under test as its admin. */
export function admin(): Promise<SignedIn> {
  const hub = inject('e2eHub');
  return signIn(hub.url, { email: hub.email, password: hub.password });
}

export { settle } from '../scripts/hub-client.ts';

/** A run once it has settled (done, failed, invalid input, cancelled), polled. */
export function settled(me: SignedIn, run: RunId, timeout = settings.HARNESS_E2E_TURN_TIMEOUT): Promise<Run> {
  return waitFor(`run ${run} to settle`, async () => {
    const got = await me.hub.call('run', { run });
    return isSettled(got.status) ? got : undefined;
  }, { timeout, every: 300 });
}

/** Run one fn by hand in a session (the chat's `!` invocation) and wait for its run to settle. */
export async function invoke(me: SignedIn, session: SessionId, fn: QualifiedName, args: Json, timeout?: number): Promise<Run> {
  const { run } = await me.hub.call('invoke', { session, fn, args, client: clientInfo() });
  return settled(me, run, timeout);
}

/** Upload bytes to the hub's content store, as the browser does, and give their ref. */
export async function upload(me: SignedIn, name: string, mime: string, bytes: Uint8Array): Promise<ContentRef> {
  const { url, upload: id } = await me.hub.call('upload', { name, mime, size: bytes.length });
  const put = await fetch(new URL(url, inject('e2eHub').url), { method: 'PUT', body: new Blob([new Uint8Array(bytes)], { type: mime }), headers: { 'content-type': mime } });
  if (!put.ok) { throw new Error(`the hub refused the upload of ${name}: HTTP ${put.status}`); }
  return me.hub.call('uploaded', { upload: id });
}

/** Every run in a turn's tree, depth first. */
export function runsOf(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap(runsOf)];
}
