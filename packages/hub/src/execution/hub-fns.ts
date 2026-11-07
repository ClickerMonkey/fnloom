/**
 * The hub fns about runs, implemented by the execution module against the hub contract: `hub/run_status` (where a
 * run is, with its progress or result) and `hub/run_wait` (wait for a run, such as one moved to the background).
 */
import { hub, type FnErrorType, type Infer } from '@harness/sdk';
import { Json, RunId, type FnError, type Run } from '@harness/core';
import type { HubFns } from './executors.ts';
import type { HubRunService } from './runs.ts';

/** A failure as the hub contract's gin type holds it (absent fields left out, not `undefined`). */
function errorOf(error: FnError): Infer<typeof FnErrorType> {
  return {
    class: error.class,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}

/** A run as `run_status` and `run_wait` report it. */
function report(run: Run) {
  const outcome = run.outcome;
  return {
    status: run.status,
    ...(run.progress === undefined ? {} : { progress: Json.parse(run.progress) }),
    ...(outcome?.status === 'done' ? { result: outcome.result } : {}),
    ...(outcome?.status === 'failed' ? { error: errorOf(outcome.error) } : {}),
  };
}

/** Find a run by the id the model wrote, or say there is none. */
async function find(runs: Pick<HubRunService, 'get'>, id: string): Promise<Run> {
  const parsed = RunId.safeParse(id);
  const run = parsed.success ? await runs.get(parsed.data) : undefined;
  if (run === undefined) throw new Error(`There is no run ${id}.`);
  return run;
}

/** Register the run fns on the hub's fn executor. */
export function registerRunFns(fns: HubFns, runs: Pick<HubRunService, 'get' | 'wait'>): void {
  fns.register(hub.fns.run_status, async (args) => report(await find(runs, args.run)));
  fns.register(hub.fns.run_wait, async (args, ctx) => {
    const run = await find(runs, args.run);
    const timeout = args.timeout ?? ctx.request.budget.time;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      runs.wait(run.id),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, timeout)); }),
      new Promise<void>((resolve) => { ctx.signal.addEventListener('abort', () => { resolve(); }, { once: true }); }),
    ]);
    clearTimeout(timer);
    const { progress: _progress, ...rest } = report(await find(runs, args.run));
    return rest;
  });
}
