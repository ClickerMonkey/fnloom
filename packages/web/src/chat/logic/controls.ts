/**
 * The chat's one stop / pause / resume control, as pure rules: which actions a choice of runs allows and what the
 * `control` call is sent. A choice is every run (`'all'`, the default: the call names no runs, so the hub applies it
 * to everything running, including runs started after the panel opened) or a set of the session's controllable runs.
 */
import type { ControllableRun, RunId, SessionControlAction, SessionControls } from '@harness/core';

/** What a person can do to running work. */
export type ControlVerb = SessionControlAction;

/** Which runs the control applies to. */
export type RunChoice = 'all' | ReadonlySet<RunId>;

/** One action as the control offers it: whether it can be pressed, and the runs it would name (`undefined`: all). */
export interface ControlPlan {
  readonly enabled: boolean;
  readonly runs: readonly RunId[] | undefined;
}

/**
 * What `verb` does for `choice`. All: the session-wide flags decide (resume: whether anything is paused). A set: the
 * chosen runs that allow the verb, and it is pressable when at least one does.
 */
export function controlPlan(controls: SessionControls | undefined, paused: boolean, choice: RunChoice, verb: ControlVerb): ControlPlan {
  const runs = controls?.runs ?? [];
  if (choice === 'all') {
    const enabled = verb === 'pause' ? controls?.pause === true
      : verb === 'cancel' ? controls === undefined || controls.cancel
        : paused || runs.some((run) => run.resume);
    return { enabled, runs: undefined };
  }
  const targets = runs.filter((run) => choice.has(run.run) && run[verb]).map((run) => run.run);
  return { enabled: targets.length > 0, runs: targets };
}

/** The runs worth choosing between: listed only when there are two or more (one run is the same as all). */
export function choosableRuns(controls: SessionControls | undefined): readonly ControllableRun[] {
  const runs = controls?.runs ?? [];
  return runs.length > 1 ? runs : [];
}

/** A choice with one run flipped; choosing every run again goes back to all. */
export function toggleRun(choice: RunChoice, run: RunId, every: readonly ControllableRun[]): RunChoice {
  const next = new Set(choice === 'all' ? every.map((r) => r.run) : choice);
  if (next.has(run)) { next.delete(run); } else { next.add(run); }
  return next.size === every.length ? 'all' : next;
}

/** What a turn's own controls can do to it: carry it on, undo it and send its question again, or undo it. */
export type TurnVerb = 'continue' | 'retry' | 'undo';

/** Where a turn stands in its thread, as the turn controls need it. */
export interface TurnStanding {
  /** It is the latest turn that still stands (`ThreadState.lastTurn`). */
  readonly last: boolean;
  /** The hub lets the latest turn be undone now (`SessionControls.undoLastTurn`). */
  readonly undoable: boolean;
  /** The hub says the latest turn's agent can carry on (`SessionControls.continueLastTurn`). */
  readonly continuable: boolean;
  /** It began with a person's message, which Retry sends again. */
  readonly asked: boolean;
}

/**
 * The turn controls that can work on a turn, in the order a menu shows them. The hub undoes only the latest turn that
 * stands (a turn can't be undone while a later one stands), so Retry and Undo, and Continue, which carries the
 * latest turn's run on, are offered there alone; Retry also needs the question it sends again.
 */
export function turnVerbs(turn: TurnStanding): TurnVerb[] {
  if (!turn.last) return [];
  return [
    ...(turn.continuable ? ['continue' as const] : []),
    ...(turn.undoable && turn.asked ? ['retry' as const] : []),
    ...(turn.undoable ? ['undo' as const] : []),
  ];
}
