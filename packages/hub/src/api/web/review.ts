/**
 * Build 7, the review slice (admins): what a system declares and adds, its install checks, what is live and what
 * waits; going live or approving a pending review by the hash the admin reviewed; test calls while it is installed;
 * and the refusals the hub logged when a system went past what it declared. The systems plugin binds `adminOnly`.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { mintId, reviewSlice, type ActorId, type FnFacts, type PreviewShot, type RefusalPage, type RefusalQuery, type RunId, type SystemName, type SystemReview, type TestCallRequest } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { ContentStore } from '../index.ts';
import { messageOf } from '../../catalog/scope.ts';
import { timeInfo } from '../../execution/time.ts';
import type { Where } from '../../store/index.ts';
import { userInfo, type FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** How many refusals a page holds when the query doesn't say. */
const REFUSAL_PAGE = 50;
/** How many of the newest refusals the review shows. */
const REVIEW_REFUSALS = 10;

/** Everything the review page shows about one system beyond its other endpoints. */
export async function systemReview(
  hub: Pick<HubServices, 'store' | 'catalog' | 'fns' | 'log'> & { readonly link: Pick<HubServices['link'], 'lifecycle'>; readonly api: { readonly content: Pick<ContentStore, 'presignDownload'> } },
  system: SystemName,
): Promise<SystemReview> {
  const [record, manifest, fns, review, off] = await Promise.all([
    hub.store.table('systems').get(system), hub.catalog.manifest(system), hub.catalog.fns({ system }), hub.link.lifecycle.review(system), hub.link.lifecycle.offItems(system),
  ]);
  if (record === undefined || manifest === undefined) { throw reject(404, 'NO_SYSTEM', `${system} hasn't sent its contract yet`); }
  const facts: FnFacts[] = [];
  for (const fn of fns) {
    try { facts.push(await hub.fns.facts.facts(fn.name)); } catch (error) {
      // a fn whose facts can't be worked out now (its kind's system is away) is listed without them
      hub.log.warn('review.facts-failed', { fn: fn.name, error: messageOf(error) });
    }
  }
  const [total, last] = await Promise.all([
    hub.store.table('refusals').count({ system }),
    hub.store.table('refusals').find({ where: { system }, order: [['at', 'desc']], limit: REVIEW_REFUSALS }),
  ]);
  const previewUrls = await previewLinks(hub.api.content, review?.checks?.tests?.previews ?? []);
  return {
    system, stage: record.stage ?? 'live', manifest, facts, off, refusals: { total, last: last.items },
    ...(Object.keys(previewUrls).length === 0 ? {} : { previewUrls }),
    ...(review?.checks === undefined ? {} : { checks: review.checks }),
    ...(review?.live === undefined ? {} : { live: review.live }),
    ...(review?.pending === undefined ? {} : { pending: review.pending }),
  };
}

/** A presigned link to each preview image, by its content hash, named after the component, state, viewport and theme. */
async function previewLinks(content: Pick<ContentStore, 'presignDownload'>, shots: readonly PreviewShot[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const shot of shots) {
    if (out[shot.image.hash] === undefined) { out[shot.image.hash] = await content.presignDownload(shot.image, `${shot.component}-${shot.state}-${shot.viewport}-${shot.theme}.png`); }
  }
  return out;
}

/** A page of refusals, newest first. */
export async function refusalPage(hub: Pick<HubServices, 'store'>, query: RefusalQuery): Promise<RefusalPage> {
  const where: Where<RefusalPage['items'][number]> = { ...(query.system === undefined ? {} : { system: query.system }), ...(query.rule === undefined ? {} : { rule: query.rule }) };
  const page = await hub.store.table('refusals').find({ where, order: [['at', 'desc']], limit: query.limit ?? REFUSAL_PAGE, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
  return { items: page.items, ...(page.cursor === undefined ? {} : { next: page.cursor }) };
}

/**
 * Run a fn of an installed system (or one waiting for review) as the admin, marked as a test: a turn of its own, the
 * run started and left to finish; the page follows it by its id.
 */
export async function testCall(hub: Pick<HubServices, 'store' | 'catalog' | 'execution' | 'clock' | 'log'>, request: TestCallRequest, by: ActorId): Promise<{ run: RunId }> {
  const fn = await hub.catalog.fn(request.fn);
  if (fn === undefined) { throw reject(404, 'NO_FN', `no fn ${request.fn}`); }
  const actor = await hub.store.table('actors').get(by);
  if (actor?.kind !== 'user') { throw reject(403, 'NOT_A_PERSON', 'only a person can make a test call'); }
  const user = await userInfo(hub, actor);
  const now = hub.clock();
  const turn = mintId('turn');
  const limits = await hub.execution.limits.resolve({ user, turn });
  await hub.store.table('turns').insert({ id: turn, actor: by, user, time: timeInfo(now, user.timeZone), status: 'running', limits, cost: 0, errors: { max: 1 }, createdAt: now });
  const { run, settled } = await hub.execution.runs.start({
    fn: fn.name, args: request.args, turn, key: `test:${fn.name}`, actor: by, caller: by, priority: limits.priority, background: false, handlers: [], test: true,
    ...(request.instance === undefined ? {} : { on: request.instance }),
  });
  await hub.store.table('turns').update(turn, { root: run });
  void settled.then(async (outcome) => {
    await hub.store.table('turns').update(turn, { status: outcome.status === 'done' ? 'done' : 'failed', endedAt: hub.clock() });
  }).catch((error: unknown) => { hub.log.warn('review.test-call-failed', { run, error: messageOf(error) }); });
  hub.log.info('review.test-call', { fn: fn.name, run, by });
  return { run };
}

/** The review plugin. Requires the systems plugin, which binds `adminOnly`. */
export function reviewPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  const { lifecycle } = hub.link;
  return plugin({ name: 'web.review', spec: reviewSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof reviewSlice> => ({
      systemReview: ({ data }) => systemReview(hub, data.system),
      goLive: ({ data, user }) => lifecycle.goLive(data, user.id),
      approveReview: ({ data, user }) => lifecycle.approve(data, user.id),
      rejectReview: ({ data, user }) => lifecycle.reject(data.system, data.hash, user.id),
      testCall: ({ data, user }) => testCall(hub, data, user.id),
      refusals: ({ data }) => refusalPage(hub, data),
    }));
}
