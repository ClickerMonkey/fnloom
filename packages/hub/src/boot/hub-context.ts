/**
 * The hub's own context items: markdown files with a header in `packages/hub/context/`, as a system's context folder is
 * (plan injected-context-2026-11-22, section 5: "minimal core in code; the hub's features as hub context files"). Each
 * is one of the hub's features an admin could switch off for an agent (memory, earlier chats, resources, attached files,
 * asking mid-task, saved fns, background runs, undo, examples, what the app can't do, that nothing runs later), injected
 * into the chat agents (`inject: { into: ['hub/chat*'] }`, order 10 to 30) with the fns it brings. The SDK's
 * `hub.context` has a ref to each (`HUB_CONTEXT_KEYS`), so a system's item can replace one (`replaces`). They join the hub's manifest at boot, so
 * each has a key (`hub/memory`), a page, a version history and a switch like any context item; the hub isn't reviewed.
 */
import { fileURLToPath } from 'node:url';
import { qualify, type ContextDecl, type Manifest } from '@harness/core';
import { checkContextFolder, ContextFolderError } from '@harness/sdk/server';

/** Where the hub's context files are. */
export const HUB_CONTEXT_DIR = fileURLToPath(new URL('../../context/', import.meta.url));

/** The hub's agent kind, as a fn declaration names it. */
const AGENT_KIND = 'hub/llm';

/**
 * Read and check the hub's context folder against its own manifest: every file parses, every fn and context it names
 * is the hub's, and every exact `inject.into` is one of its agents. A folder with problems fails the start.
 */
export async function hubContext(manifest: Pick<Manifest, 'name' | 'fns' | 'context'>, dir: string = HUB_CONTEXT_DIR): Promise<ContextDecl[]> {
  const system = manifest.name;
  const checked = await checkContextFolder(dir, {
    system,
    fns: new Set(manifest.fns.map((decl) => qualify(system, decl.name))),
    context: new Set(manifest.context.map((decl) => qualify(system, decl.name))),
    agents: new Set(manifest.fns.filter((decl) => decl.kind === AGENT_KIND).map((decl) => qualify(system, decl.name))),
  }, 'hub/context');
  if (checked.problems.length > 0) throw new ContextFolderError(checked.problems);
  return checked.files.map((file) => file.decl);
}

/** The hub's manifest with its context files added to its context. */
export async function withHubContext<M extends Pick<Manifest, 'name' | 'fns' | 'context'>>(manifest: M, dir?: string): Promise<M> {
  return { ...manifest, context: [...manifest.context, ...await hubContext(manifest, dir)] };
}
