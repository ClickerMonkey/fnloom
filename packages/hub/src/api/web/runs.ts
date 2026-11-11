/**
 * The runs slice: a turn's fn tree, the run and LLM call inspectors, moving a run to the background, undoing a turn,
 * what waits on the person in a session (so a reload shows it again), approvals, answers to handlers a run asked a person, renderer actions and form submissions, and the session state
 * a renderer draws from. Every record is checked against what the person may see first (404 otherwise), and an
 * approval or handler call that is already settled answers 409 before its module is asked.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { runsSlice, compact, RunSummary, type LlmInteraction, type Run, type RunId, type TreeNode, type Turn } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { personOperations } from '../person-ops.ts';
import { visibleRun, visibleSession, type FullHandlers } from './access.ts';
import { collect } from '../paging.ts';
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';

const PAGE = 200;

/** A turn's fn tree from its runs and LLM calls: children under their parent, each in the order it started. */
export function buildTree(turn: Pick<Turn, 'root'>, runs: readonly Run[], calls: readonly LlmInteraction[]): TreeNode | undefined {
  const children = new Map<RunId | undefined, Run[]>();
  for (const run of runs) {
    const siblings = children.get(run.parent) ?? [];
    siblings.push(run);
    children.set(run.parent, siblings);
  }
  const node = (run: Run): TreeNode => ({
    run: RunSummary.parse(run),
    llmCalls: calls.filter((call) => call.run === run.id).map(({ id, model, cost, status }) => ({ id, model, cost, status })),
    children: (children.get(run.id) ?? []).map(node),
  });
  const root = runs.find((run) => run.id === turn.root) ?? children.get(undefined)?.[0];
  return root === undefined ? undefined : node(root);
}

/** The runs plugin. */
export function runsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  const person = personOperations(hub);
  const { chat, execution, store } = hub;
  return plugin({ name: 'web.runs', spec: runsSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof runsSlice> => ({
      background: ({ data, user }) => person.run_background(data, user),
      undoTurn: ({ data, user }) => person.turn_undo(data, user),
      tree: ({ data, user }) => reads.run_tree(data, user),
      run: ({ data, user }) => reads.run_get(data, user),
      llmCall: ({ data, user }) => reads.llm_call(data, user),
      waiting: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        const [approvals, calls] = await Promise.all([
          collect((cursor) => store.table('approvals').find({ where: { status: 'pending' }, order: [['createdAt', 'asc']], limit: PAGE, cursor })),
          collect((cursor) => store.table('handlerCalls').find({ where: { status: 'pending' }, limit: PAGE, cursor })),
        ]);
        const runs = await Promise.all([...new Set([...approvals.map((a) => a.run), ...calls.map((c) => c.run)])].map((id) => store.table('runs').get(id)));
        const here = new Set(runs.flatMap((run) => (run?.session === data.session ? [run.id] : [])));
        return {
          approvals: approvals.filter((a) => here.has(a.run)),
          handlers: calls.filter((c) => here.has(c.run) && 'user' in c.answerer && c.answerer.user === user.id),
        };
      },
      approve: async ({ data: { approval, ...answer }, user }) => {
        const pending = await store.table('approvals').get(approval);
        if (pending === undefined) { throw reject(404, 'APPROVAL_NOT_FOUND', 'no such approval'); }
        await visibleRun(hub, pending.run, user);
        if (pending.status !== 'pending') { throw reject(409, 'APPROVAL_SETTLED', `this approval is already ${pending.status}`); }
        const answered = await execution.policies.answer(approval, { ...compact(answer), by: user.id });
        hub.log.info('approval.answered', { approval, approve: answer.approve, remember: answer.remember, user: user.id });
        return answered;
      },
      answer: async ({ data, user }) => {
        const call = await store.table('handlerCalls').get(data.call);
        // Only the person a call asked may see it; to anyone else it doesn't exist.
        if (call === undefined || !('user' in call.answerer) || call.answerer.user !== user.id) {
          throw reject(404, 'HANDLER_CALL_NOT_FOUND', 'no such handler call');
        }
        if (call.status !== 'pending') { throw reject(409, 'HANDLER_CALL_SETTLED', 'this has already been answered'); }
        await execution.handlers.answer(data.call, data.value, user.id);
      },
      act: async ({ data, user }) => {
        await visibleSession(hub, data.session, user);
        return { delivery: await chat.deliveries.act({ ...compact(data), actor: user.id }) };
      },
      submit: async ({ data, user }) => {
        await visibleRun(hub, data.run, user);
        return { delivery: await chat.deliveries.submit({ ...data, actor: user.id }) };
      },
      state: async ({ data, user }) => {
        await visibleRun(hub, data.run, user);
        return chat.state.forRun(data.run);
      },
    }));
}
