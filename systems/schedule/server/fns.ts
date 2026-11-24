/**
 * The schedule system's chat fns (docs/plans/schedule-system.md, "The chat side"), over the timer's seams and the hub:
 *
 * - **add** saves a new `schedule/schedule` fn with `hub/fns_save`: the target read with `hub/fns_get`, its `when`
 *   checked (the gap between times, that it runs at all), its args a literal program (fixed `args`) or one the
 *   `compute` authoring step writes from plain words, all checked by the kind's own `scheduleProblems` before the hub
 *   checks it again. It answers with the schedule as the chat shows it (`ScheduleView`): its words, the next three
 *   runs, the first run's args and when the person is notified.
 * - **change**, **pause**, **resume** and **skip** save a new version of the schedule over the old (`replace`), so the
 *   hub keeps every version; **remove** removes it with `hub/fns_remove` (the hub keeps its versions; its firings stay).
 * - **list** reads the person's schedules as the timer knows them (`kindFns`), each with how its last run went (the
 *   `schedule/Firing` records); **history** is a page of those records.
 * - **remind** notifies its own person with a text (`ctx.notify`): what "remind me" is scheduled as.
 *
 * Args checks: `add` and `change` check a call before the hub's policies and the approval card (`check`, reading
 * `hub/fns_get` only): the target exists and can run, fixed args fit its args type (`fixedProblems`), `when` runs and
 * its times are far enough apart, the person has room for one more, and a changed schedule is theirs. Args worked out
 * from words are a model call, so they wait for the run.
 *
 * Undo: each saving fn's run has the hub save (or remove) as its child, and the hub undoes that child with the turn
 * (`hub/fns_save` puts back the version before, or removes the fn it made; `hub/fns_remove` restores the last version),
 * so the schedule goes back as the design says (add removes it, change and pause go back a version, remove brings it
 * back). Each fn's own undo is that step said in words: an undo has no fn calls of its own.
 *
 * Only a schedule's owner changes it (a schedule runs as them); an admin may also pause and resume anyone's.
 */
import type { ExprDef } from '@aeye/gin';
import { fnOfModelNameByRule, Json, QualifiedName, splitName, type InputProblem, type KindFnShape, type PreviewAnswer, type PreviewPart } from '@harness/core';
import { CallFailed, g, SAVE_FN_TAKEN, wireType, type Infer, type KindCheckCtx, type StoredFn, type SystemImpl } from '@harness/sdk';
import { hubProgramHost, type ProgramLookups } from '@harness/sdk/program';
import { AuthoringError } from '@harness/sdk/server';
import { ALLOW_RUNS_LABEL, schedule, type AddArgs, type ChangeArgs, type ScheduleContract } from '../shared/index.ts';
import { FiringShape, gapProblems, OccurrenceKey, SchedulePayload, ScheduleView, When, Zone, type Fire, type FiringStatus, type PreviousFiring } from '../shared/types.ts';
import { describeWhen, firingsOnDays, nextFirings, occurrenceKey, type Occurrence } from '../shared/when.ts';
import { localNow, localString, zonedTime } from '../shared/zoned.ts';
import { ArgsFailed, evaluateArgs, fixedProblems, type TargetSignature } from './args.ts';
import { argsAuthoring, ArgsAuthoring, computeRequest, runWords } from './authoring.ts';
import { scheduleProblems } from './kind.ts';
import type { Clock, Timer } from './timer.ts';

type Impl = SystemImpl<ScheduleContract['defs']>;
type Fns = Impl['fns'];
type CtxOf<K extends keyof Fns> = Parameters<Fns[K]['run']>[1];
type AddCtx = CtxOf<'add'>;
type View = ScheduleView;
type StoredFnValue = Infer<typeof StoredFn>;

/** The schedule kind's name, as saved fns carry it. */
const KIND = schedule.kinds.schedule.name;
/** How many coming runs a view lists. */
const NEXT = 3;
/** A history page. */
const HISTORY_PAGE = 50;
/** The longest local name a schedule gets from its words. */
const NAME_CHARS = 48;
/** How many numbered names are tried when one is taken. */
const NAME_TRIES = 20;

/** What the chat fns are built from: the timer (its schedules, rows and limits) and the clock they read. */
export interface ScheduleFnsDeps {
  readonly timer: Timer;
  readonly clock: Clock;
}

/** A run that reads fns from the hub (`hub/fns_get` as its dep `getFn`). */
interface ReadsFns {
  readonly fns: { readonly getFn: (args: { fn: QualifiedName }) => PromiseLike<StoredFnValue> };
  readonly run: AddCtx['run'];
  readonly types: AddCtx['types'];
  readonly data: AddCtx['data'];
}

/** What looking a fn and its types up needs: `hub/fns_get` and the hub's named types (a run, or an args check). */
type Reads = Pick<ReadsFns, 'fns' | 'types'>;

/** The person a schedule fn is run for, as its run and its args check both know them. */
interface Person {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly timeZone: string;
}

/** A run that saves schedules (`hub/fns_save` as its dep `saveFn`). */
interface SavesFns extends ReadsFns {
  readonly fns: ReadsFns['fns'] & { readonly saveFn: AddCtx['fns']['saveFn'] };
}

/** Something a fn refused, in words, for `ctx.fail('caller', …)`. */
class Refused extends Error {
  override readonly name = 'Refused';
}

/** Args that were wrong in a way their types can't say, by path, for `ctx.invalid`. */
class Invalid extends Error {
  override readonly name = 'Invalid';
  readonly problems: InputProblem[];
  constructor(problems: InputProblem[]) {
    super(problems.map((problem) => `${problem.path}: ${problem.message}`).join(' '));
    this.problems = problems;
  }
}

/** A fn name as the model wrote it (qualified, or its tool spelling), or undefined. */
export function nameOf(raw: string): QualifiedName | undefined {
  const parsed = QualifiedName.safeParse(raw.includes('/') ? raw : fnOfModelNameByRule(raw) ?? raw);
  return parsed.success ? parsed.data : undefined;
}

/** A schedule's local name from words: lower case, `_` between words, at most `NAME_CHARS`. */
export function slugOf(words: string): string {
  const slug = words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, NAME_CHARS).replace(/_+$/, '');
  return slug === '' ? 'schedule' : /^[a-z]/.test(slug) ? slug : `schedule_${slug}`;
}

/** The local name a new schedule gets: its `name`, else a reminder's first words, else the fn it runs. */
export function localNameOf(args: { name?: string | undefined; fn: QualifiedName; fixed?: Json | undefined }): string {
  if (args.name !== undefined) { return slugOf(args.name); }
  if (args.fn === schedule.fns.remind.name && isObject(args.fixed) && typeof args.fixed['text'] === 'string') {
    return slugOf(`reminder ${args.fixed['text'].split(/\s+/).slice(0, 5).join(' ')}`);
  }
  return slugOf(splitName(args.fn).local);
}

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value as JSON, its absent optional fields (`undefined`) left out, as the hub keeps it. */
export function jsonOf(value: unknown): Json {
  return Json.parse(JSON.parse(JSON.stringify(value ?? null)));
}

/** Whether a value is a list of `{ key, value }` pairs and nothing else (the strict encoding of an object). */
function isPairs(value: Json): value is Array<{ key: string; value: Json }> {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isObject(item) && typeof item['key'] === 'string' && 'value' in item && Object.keys(item).length === 2);
}

/**
 * Fixed args as the caller meant them. A model on a strict tool schema can't write an open JSON object (OpenAI's strict
 * mode has none), so the free-form `args` comes as the strict encoding of one: a list of `{ key, value }` pairs. Such a
 * list, at any depth, is read back as the object it spells; every other value is kept as it is.
 */
export function fromPairs(value: Json): Json {
  if (isPairs(value)) { return Object.fromEntries(value.map((pair) => [pair.key, fromPairs(pair.value)])); }
  if (Array.isArray(value)) { return value.map(fromPairs); }
  if (isObject(value)) { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromPairs(item)])); }
  return value;
}

/** A zone the person's own zone gives, or UTC when theirs isn't one Intl knows. */
function personZone(timeZone: string): Zone {
  const parsed = Zone.safeParse(timeZone);
  return parsed.success ? parsed.data : Zone.parse('UTC');
}

/** The literal args program for fixed args: one `new` of the target's args type. */
export function literalArgs(signature: TargetSignature, fixed: Json | undefined): ExprDef {
  return { kind: 'new', type: signature.args, value: fixed ?? {} };
}

/** The fixed args a schedule's program is, when it is one this system wrote as a literal (no words). */
export function fixedOf(payload: Pick<SchedulePayload, 'args' | 'argsAsked'>): Json | undefined {
  if (payload.argsAsked !== undefined) { return undefined; }
  const args: unknown = payload.args;
  return isObject(args) && args['kind'] === 'new' ? jsonOf(args['value'] ?? {}) : undefined;
}

/** `fire` for one coming run: its instant, local day and time, zone and count; not late, not by hand. */
export function fireOf(occurrence: Occurrence, zone: Zone, count: number): Fire {
  return { at: occurrence.at, local: localString(occurrence.at, zone), day: occurrence.day, ...(occurrence.time === undefined ? {} : { time: occurrence.time }), zone, count, late: 0, manual: false };
}

/** Where the coming runs start: now, or the day a pause ends; nothing while paused with no end. */
function planFrom(payload: SchedulePayload, now: number): number | undefined {
  const paused = payload.paused;
  if (paused === undefined) { return now; }
  if (paused.until === undefined) { return undefined; }
  return Math.max(now, zonedTime(paused.until, 0, payload.zone));
}

/** A schedule's coming runs from now (none while paused with no end). */
export function comingRuns(payload: SchedulePayload, now: number, count = NEXT): Occurrence[] {
  const from = planFrom(payload, now);
  return from === undefined ? [] : nextFirings(payload.when, payload.zone, from, count);
}

/** A schedule as the chat's results and the pages show it. */
export function viewOf(name: QualifiedName, payload: SchedulePayload, input: { now: number; viewerZone: string; firstArgs?: Json | undefined; last?: View['last'] }): View {
  const today = localNow(input.now, payload.zone).day;
  return ScheduleView.parse({
    schedule: name, fn: payload.fn,
    says: describeWhen(payload.when, payload.zone, { viewerZone: input.viewerZone, today }),
    zone: payload.zone, notify: payload.notify,
    next: comingRuns(payload, input.now).map((occurrence) => ({ at: occurrence.at, local: runWords(occurrence) })),
    ...(input.firstArgs === undefined ? {} : { firstArgs: input.firstArgs }),
    ...(payload.paused === undefined ? {} : { paused: payload.paused.until === undefined ? {} : { until: payload.paused.until } }),
    ...(payload.runsAllowed === undefined ? {} : { runsAllowed: true }),
    ...(input.last === undefined ? {} : { last: input.last }),
  });
}

/** Program lookups for a run: named types from the hub; the args program calls no fns. */
function lookupsOf(ctx: Pick<ReadsFns, 'types'>): ProgramLookups {
  return { types: (names) => ctx.types.definitions(names), fn: () => Promise.resolve(undefined) };
}

/** A fn's shape as the kind's check reads it, from `hub/fns_get` as the run's person; undefined when they can't see it. */
async function shapeOf(ctx: Pick<ReadsFns, 'fns'>, name: QualifiedName): Promise<KindFnShape | undefined> {
  try {
    const stored = await ctx.fns.getFn({ fn: name });
    return stored.args === undefined || stored.returns === undefined ? undefined : { args: stored.args, returns: stored.returns, description: stored.description, mode: 'write' };
  } catch (error) {
    if (error instanceof CallFailed) { return undefined; }
    throw error;
  }
}

/** The kind's check context in a run: types and fns as the run's person sees them, so `scheduleProblems` runs before the save. */
function checkCtxOf(ctx: Reads): KindCheckCtx {
  return {
    type: async (name) => (await ctx.types.definitions([name])).types.find((type) => type.name === name)?.def,
    fn: (name) => shapeOf(ctx, name),
  };
}

/** The fn a schedule is to run, with its signature; refused in words when it can't be scheduled. */
async function targetOf(ctx: Pick<ReadsFns, 'fns'>, raw: string): Promise<{ name: QualifiedName; signature: TargetSignature }> {
  const name = nameOf(raw);
  if (name === undefined) { throw new Invalid([{ path: 'fn', message: `${raw} is not a fn's name: give it as your tools and search hits spell it.` }]); }
  let stored: StoredFnValue;
  try {
    stored = await ctx.fns.getFn({ fn: name });
  } catch (error) {
    if (!(error instanceof CallFailed)) { throw error; }
    throw new Invalid([{ path: 'fn', message: `${name} is not a fn the person can run (${error.message}): find it with hub/fns_search first.` }]);
  }
  if (stored.kind === KIND) { throw new Invalid([{ path: 'fn', message: `${name} is a schedule itself: schedule the fn it runs, or change it with ${schedule.fns.change.name}.` }]); }
  if (!stored.available) { throw new Refused(`${name} can't run for the person now${stored.blocked === undefined ? '' : `: ${stored.blocked.reason}`}, so it can't be scheduled.`); }
  if (stored.args === undefined || stored.returns === undefined) { throw new Refused(`The hub gave no signature for ${name}, so its args can't be checked.`); }
  return { name, signature: { args: stored.args, returns: stored.returns } };
}

/** A schedule of the person's, as the hub keeps it; refused in words when there is none, or it is someone else's. */
async function ownSchedule(ctx: Pick<ReadsFns, 'fns'>, raw: string, user: Person, options: { admin?: boolean } = {}): Promise<{ name: QualifiedName; stored: StoredFnValue; payload: SchedulePayload }> {
  const name = nameOf(raw);
  const missing = `${raw} is not a schedule of the person's: ${schedule.fns.list.name} names theirs.`;
  if (name === undefined) { throw new Invalid([{ path: 'schedule', message: missing }]); }
  let stored: StoredFnValue;
  try {
    stored = await ctx.fns.getFn({ fn: name });
  } catch (error) {
    if (!(error instanceof CallFailed)) { throw error; }
    throw new Invalid([{ path: 'schedule', message: missing }]);
  }
  if (stored.kind !== KIND) { throw new Invalid([{ path: 'schedule', message: `${name} is not a schedule (it is a fn of ${stored.kind}): ${schedule.fns.list.name} names the person's schedules.` }]); }
  if (stored.owner !== undefined && stored.owner !== user.id && !(options.admin === true && user.role === 'admin')) {
    throw new Refused(`${name} is not ${user.name}'s: a schedule runs as the person who made it, so only they change it. To have one of their own, add a schedule that runs the same fn.`);
  }
  const payload = SchedulePayload.safeParse(stored.payload);
  if (!payload.success) { throw new Refused(`${name}'s payload doesn't read as a schedule: ${payload.error.issues.map((issue) => issue.message).join(' ')}`); }
  return { name, stored, payload: payload.data };
}

/** Every problem with a payload before it is saved: its type, the kind's own check, and that it runs at all. */
async function payloadProblems(ctx: Reads, payload: SchedulePayload, minGap: number, now: number): Promise<InputProblem[]> {
  const problems: InputProblem[] = (await scheduleProblems(payload, checkCtxOf(ctx), minGap)).map((message) => ({ path: message.startsWith('args') ? 'args' : /apart/.test(message) ? 'when.times' : 'fn', message }));
  return [...problems, ...neverRuns(payload, now)];
}

/** That a schedule runs at all: a problem at `when` when every time it gives is in the past (none while it is paused). */
function neverRuns(payload: Pick<SchedulePayload, 'when' | 'zone' | 'paused'>, now: number): InputProblem[] {
  if (payload.paused !== undefined || nextFirings(payload.when, payload.zone, now, 1).length > 0) { return []; }
  return [{ path: 'when', message: 'It would never run: every time it gives is in the past. Give a day and time still to come.' }];
}

/**
 * The problems of a schedule whose args are worked out from words after approval (a model call, so never in a check):
 * its times' gap and that it runs at all. Its target was read already; its args program doesn't exist yet.
 */
function whenProblems(payload: Pick<SchedulePayload, 'when' | 'zone' | 'paused'>, minGap: number, now: number): InputProblem[] {
  return [...gapProblems(payload.when, minGap).map((message) => ({ path: 'when.times', message })), ...neverRuns(payload, now)];
}

/** `when` and `zone` as add or change was given them, refused by path when they don't read. */
function whenOf(args: { readonly when?: unknown; readonly zone?: string | undefined }, fallbackZone: Zone): { when: When | undefined; zone: Zone } {
  const when = args.when === undefined ? undefined : When.safeParse(jsonOf(args.when));
  if (when !== undefined && !when.success) { throw new Invalid([{ path: 'when', message: `It doesn't read as a time to run: ${when.error.issues.map((issue) => `${issue.path.join('.') || 'when'}: ${issue.message}`).join('; ')}` }]); }
  const zone = args.zone === undefined ? { success: true as const, data: fallbackZone } : Zone.safeParse(args.zone);
  if (!zone.success) { throw new Invalid([{ path: 'zone', message: `${args.zone ?? ''} is not a time zone: give an IANA zone such as America/New_York.` }]); }
  return { when: when?.data, zone: zone.data };
}

/**
 * What `add` works out before the args program, in its run and in its check alike: the target and its signature, the
 * fixed args as meant (`fromPairs`), `when` and the zone (the person's own when it gives none).
 */
async function addPlan(ctx: Pick<ReadsFns, 'fns'>, args: Infer<typeof AddArgs>, user: Pick<Person, 'timeZone'>): Promise<{ target: { name: QualifiedName; signature: TargetSignature }; fixed: Json | undefined; when: When; zone: Zone }> {
  const target = await targetOf(ctx, args.fn);
  const fixed = args.args === undefined ? undefined : fromPairs(args.args);
  if (fixed !== undefined && target.signature.args.name === 'obj' && !isObject(fixed)) {
    throw new Invalid([{ path: 'args', message: `${target.name} takes its args as an object: give them by name.` }]);
  }
  const { when, zone } = whenOf(args, personZone(user.timeZone));
  if (when === undefined) { throw new Invalid([{ path: 'when', message: 'Say when it runs.' }]); }
  return { target, fixed, when, zone };
}

/** The settings of a new schedule `add` was given beyond what it runs and when. */
function addOptions(args: Infer<typeof AddArgs>): Partial<Pick<SchedulePayload, 'notify' | 'overlap' | 'missed' | 'maxSpend'>> {
  return {
    ...(args.notify === undefined ? {} : { notify: args.notify }),
    ...(args.overlap === undefined ? {} : { overlap: args.overlap }),
    ...(args.missed === undefined ? {} : { missed: args.missed }),
    ...(args.maxSpend === undefined || args.maxSpend === 0 ? {} : { maxSpend: args.maxSpend }),
  };
}

/** How many schedules the person has, refused in words when they have the most one person may. */
function roomFor(timer: Timer, user: Person): void {
  const theirs = timer.schedules().filter((fn) => fn.owner === user.id).length;
  if (theirs >= timer.limits.perPerson) {
    throw new Refused(`The person has ${String(theirs)} schedules, the most one person may have (${String(timer.limits.perPerson)}): remove one first (${schedule.fns.remove.name}).`);
  }
}

/**
 * A fn's args check (`check` in the contract): its body's refusals as problems by path (a refusal in words at the
 * whole call), none when it found nothing. Anything else it hits is left to the hub, which lets the call go on.
 */
async function checked(body: () => Promise<readonly InputProblem[]>): Promise<readonly InputProblem[]> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Invalid) { return error.problems; }
    if (error instanceof Refused) { return [{ path: '', message: error.message }]; }
    throw error;
  }
}

/** The args program a schedule keeps: a literal for fixed args, or one the compute step writes from the words. */
async function argsProgramOf(ctx: AddCtx | CtxOf<'change'>, input: {
  target: QualifiedName; signature: TargetSignature; fixed: Json | undefined; compute: string | undefined;
  payload: Pick<SchedulePayload, 'when' | 'zone'>; now: number; count: number; previous?: PreviousFiring | undefined;
}): Promise<{ args: ExprDef; argsAsked?: string }> {
  if (input.fixed !== undefined && input.signature.args.name === 'obj' && !isObject(input.fixed)) {
    throw new Invalid([{ path: 'args', message: `${input.target} takes its args as an object: give them by name.` }]);
  }
  if (input.compute === undefined) { return { args: literalArgs(input.signature, input.fixed) }; }
  const firings = nextFirings(input.payload.when, input.payload.zone, input.now, NEXT).map((occurrence, i) => fireOf(occurrence, input.payload.zone, input.count + i));
  const state = new ArgsAuthoring({
    host: hubProgramHost(ctx, async (name) => await ctx.fns.getFn({ fn: name })), lookups: lookupsOf(ctx),
    target: input.target, signature: input.signature, asked: input.compute, fixed: isObject(input.fixed) ? input.fixed : undefined, firings, previous: input.previous,
  });
  await state.prepare();
  try {
    const { session } = await argsAuthoring.run(await ctx.ai(), computeRequest(state), state);
    const draft = session.draft;
    if (draft === undefined) { throw new Refused('The args were not worked out: no program was kept.'); }
    ctx.log.info('schedule.compute.written', { fn: input.target, fixes: session.fixes });
    return { args: draft.program, argsAsked: input.compute };
  } catch (error) {
    if (!(error instanceof AuthoringError)) { throw error; }
    const last = error.problems.length === 0 ? '' : ` Its last problems: ${error.problems.join(' ')}`;
    throw new Invalid([{ path: 'compute', message: `The args could not be worked out from these words: ${error.message}${last} Say more exactly how each arg follows from the run's day and time, or give fixed values in \`args\`.` }]);
  }
}

/**
 * The first coming run's args, worked out as that run will (none when nothing is coming). A program that fails for it
 * (fixed values that don't fit the fn's args: the type check reads a literal's slots loosely) is refused at `args`.
 */
async function firstArgsOf(ctx: Pick<ReadsFns, 'types'>, payload: SchedulePayload, signature: TargetSignature, now: number, count: number, previous: PreviousFiring | undefined): Promise<Json | undefined> {
  const first = comingRuns(payload, now, 1)[0];
  if (first === undefined) { return undefined; }
  try {
    return await evaluateArgs(payload.args, signature, payload.fn, lookupsOf(ctx), { fire: fireOf(first, payload.zone, count), previous });
  } catch (error) {
    if (!(error instanceof ArgsFailed)) { throw error; }
    throw new Invalid([{ path: payload.argsAsked === undefined ? 'args' : 'compute', message: `${error.message} (for the run on ${runWords(first)}). Give ${payload.fn}'s args as its signature says.` }]);
  }
}

/** The one-line description a schedule fn is saved with: when it runs and what. */
function descriptionOf(payload: SchedulePayload, now: number): string {
  const says = describeWhen(payload.when, payload.zone, { today: localNow(now, payload.zone).day });
  return `${says} (${payload.zone}), runs ${payload.fn}${payload.argsAsked === undefined ? '' : `; its args: ${payload.argsAsked}`}.`;
}

/** Save a schedule fn as the run's person: a new one (under a free name) or a new version over one. */
async function save(ctx: SavesFns, payload: SchedulePayload, options: { local: string; replace: boolean; named: boolean; now: number }): Promise<{ fn: QualifiedName; version: number }> {
  const base = { kind: KIND, description: descriptionOf(payload, options.now), payload: jsonOf(payload), tags: ['schedules'] };
  for (let attempt = 1; attempt <= NAME_TRIES; attempt += 1) {
    const local = attempt === 1 ? options.local : `${options.local}_${String(attempt)}`;
    try {
      const saved = await ctx.fns.saveFn({ ...base, name: local, ...(options.replace ? { replace: true } : {}) });
      return { fn: QualifiedName.parse(saved.fn), version: saved.version };
    } catch (error) {
      if (!(error instanceof CallFailed)) { throw error; }
      const code = error.error.class === 'cancelled' ? undefined : error.error.code;
      if (code === SAVE_FN_TAKEN && !options.replace && !options.named) { continue; }
      if (code === SAVE_FN_TAKEN && options.named) {
        throw new Invalid([{ path: 'name', message: `schedule/${local} is taken: give another name, or change that one with ${schedule.fns.change.name}.` }]);
      }
      throw new Refused(`The hub didn't keep the schedule: ${error.message}`);
    }
  }
  throw new Refused(`Every name like schedule/${options.local} is taken: give the schedule a name.`);
}

/** The words for when a schedule's person is notified. */
const NOTIFY_WORDS = { always: 'after every run', failed: 'only when a run fails', never: 'never (every run is still on its page)' } as const;

/** The choice the add card offers: an optional tick, so Approve alone leaves runs asking as before. */
export const ALLOW_RUNS_ASK = { type: wireType(g.optional(g.bool())), into: 'allowRuns', label: ALLOW_RUNS_LABEL } as const;

/**
 * The add card (`schedule/add`'s preview): what it runs, as whom, when in words, the next three runs, its args (fixed
 * values, or the words they are worked out from) and when the person is notified, with the offer to let its runs go
 * ahead without asking (`ALLOW_RUNS_ASK`), unless the admin set firings that need approval to be refused. Refused when
 * the caller set `allowRuns` itself (only the person makes that choice, here) or `when` doesn't read.
 */
export function addPreview(args: Infer<typeof AddArgs>, input: { user: { name: string; timeZone: string }; now: number; approvals: 'wait' | 'refuse' }): PreviewAnswer {
  if (args.allowRuns !== undefined) { return { refused: 'allowRuns is the person\'s own choice, made on the approval card: leave it out.' }; }
  const target = nameOf(args.fn);
  if (target === undefined) { return { refused: `${args.fn} is not a fn's name: give it as your tools and search hits spell it.` }; }
  const when = When.safeParse(jsonOf(args.when));
  if (!when.success) { return { refused: `when doesn't read: ${when.error.issues.map((issue) => issue.message).join(' ')}` }; }
  const zone = args.zone === undefined ? personZone(input.user.timeZone) : Zone.parse(args.zone);
  const says = describeWhen(when.data, zone, { viewerZone: input.user.timeZone, today: localNow(input.now, zone).day });
  const next = nextFirings(when.data, zone, input.now, NEXT).map((occurrence) => runWords(occurrence));
  const notify = args.notify ?? 'always';
  const parts: PreviewPart[] = [
    { type: 'text', text: `Runs **${target}** by itself, as **${input.user.name}**: ${says}.\n\nNext runs: ${next.length === 0 ? 'none' : next.join('; ')}.` },
    ...(args.compute === undefined ? [] : [{ type: 'text' as const, text: `Its args are worked out for each run from these words: ${args.compute}` }]),
    ...(args.args === undefined ? [] : [{ type: 'code' as const, language: 'json', title: args.compute === undefined ? 'Its args' : 'Fixed args', code: JSON.stringify(fromPairs(args.args), null, 2) }]),
    {
      type: 'text',
      text: [
        `You are notified ${NOTIFY_WORDS[notify]}.`,
        input.approvals === 'refuse'
          ? 'Nobody watches its runs: one that needs your approval is refused (an admin set it so), and you are told.'
          : `Nobody watches its runs: one that needs your approval waits for you, and you are told. Tick "${ALLOW_RUNS_LABEL}" to let them go ahead instead; you can change that on its page.`,
      ].join(' '),
    },
  ];
  return {
    preview: { title: `Schedule ${target}: ${says}`, parts, irreversible: false },
    ...(input.approvals === 'refuse' ? {} : { ask: ALLOW_RUNS_ASK }),
  };
}

/** Why the person can't let runs go ahead: the admin's setting wins. */
const REFUSE_SET = 'An admin set scheduled runs that need approval to be refused, so they can\'t be let go ahead without asking.';

/** A run that records whether a schedule's runs go ahead without asking (`hub/fns_allow_runs` as its dep `allowRuns`). */
interface AllowsRuns {
  readonly fns: { readonly allowRuns: AddCtx['fns']['allowRuns'] };
}

/** Have the hub let a schedule's runs go ahead without asking its owner, or ask again; refused in words when it won't. */
async function allowRunsOf(ctx: AllowsRuns, name: QualifiedName, allow: boolean): Promise<void> {
  try {
    await ctx.fns.allowRuns({ fn: name, allow });
  } catch (error) {
    if (!(error instanceof CallFailed)) { throw error; }
    throw new Refused(`The hub didn't record whether ${name}'s runs ask: ${error.message}`);
  }
}

/** How the last run of each schedule went, from the person's firing records. */
async function lastRuns(ctx: Pick<ReadsFns, 'data'>, names: readonly QualifiedName[]): Promise<Map<string, NonNullable<View['last']>>> {
  const out = new Map<string, NonNullable<View['last']>>();
  if (names.length === 0) { return out; }
  const page = await ctx.data.find(schedule.types.Firing, {
    query: { filters: [{ field: 'schedule', op: 'in', values: [...names] }], sort: [{ field: 'at', dir: 'desc' }], limit: Math.min(100, names.length * 5) },
  });
  for (const record of page.items) {
    const value = record.value;
    if (out.has(value.schedule)) { continue; }
    out.set(value.schedule, { at: value.at, status: value.status, ...(value.run === undefined ? {} : { run: value.run }), ...(value.summary === undefined ? {} : { summary: value.summary }) });
  }
  return out;
}

/** Run a fn's body, turning its refusals and wrong args into the run's outcome. */
async function guarded<C extends { fail: (cls: 'caller', message: string) => R; invalid: (problems: readonly InputProblem[]) => R }, R>(ctx: C, body: () => Promise<R>): Promise<R> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Invalid) { return ctx.invalid(error.problems); }
    if (error instanceof Refused) { return ctx.fail('caller', error.message); }
    throw error;
  }
}

/** The changes `schedule/change` was asked for, as a payload over the current one (args and words worked out by the caller). */
type Changes = Partial<Pick<SchedulePayload, 'fn' | 'when' | 'zone' | 'notify' | 'overlap' | 'missed' | 'maxSpend'>>;

/** What `change` was asked, as its implementation gets it. */
type ChangeArgsValue = Infer<typeof ChangeArgs>;

/**
 * What `change` works out before any args program, in its run and its check alike: the schedule with the asked changes
 * over it (`merged`, its program still the old one) and the new target's signature when it runs another fn.
 */
async function changePlan(ctx: Pick<ReadsFns, 'fns'>, own: { payload: SchedulePayload }, args: ChangeArgsValue): Promise<{ merged: SchedulePayload & Changes; signature: TargetSignature | undefined }> {
  const changes: Changes = {};
  let signature: TargetSignature | undefined;
  if (args.fn !== undefined) {
    const target = await targetOf(ctx, args.fn);
    changes.fn = target.name;
    signature = target.signature;
  }
  const { when, zone } = whenOf(args, own.payload.zone);
  if (when !== undefined) { changes.when = when; }
  if (args.zone !== undefined) { changes.zone = zone; }
  if (args.notify !== undefined) { changes.notify = args.notify; }
  if (args.overlap !== undefined) { changes.overlap = args.overlap; }
  if (args.missed !== undefined) { changes.missed = args.missed; }
  if (args.maxSpend !== undefined) { changes.maxSpend = args.maxSpend === 0 ? undefined : args.maxSpend; }
  return { merged: { ...own.payload, ...changes }, signature };
}

/** A schedule's args program as it keeps it: the program, and the words it was worked out from when it was. */
function programOf(payload: SchedulePayload): { args: ExprDef; argsAsked?: string } {
  return { args: payload.args, ...(payload.argsAsked === undefined ? {} : { argsAsked: payload.argsAsked }) };
}

/** The payload `change` saves: the merged schedule with its args program (and its spending cap only when it has one). */
function changedPayload(merged: SchedulePayload & Changes, program: { args: ExprDef; argsAsked?: string }): SchedulePayload {
  const { argsAsked: _asked, maxSpend: _spend, ...rest } = merged;
  return SchedulePayload.parse({ ...rest, ...(merged.maxSpend === undefined ? {} : { maxSpend: merged.maxSpend }), ...program });
}

/** Build the chat fns over the timer and the clock. */
export function scheduleFns(deps: ScheduleFnsDeps): Fns {
  const { timer, clock } = deps;

  /**
   * A changed schedule saved over the old one, answered as its view; nothing is saved when nothing changed. A change of
   * what it runs or of its args (`argsChanged`) is refused when the first run's args don't work out; a pause, resume or
   * skip goes through whatever its args do (they are checked again when it runs).
   */
  const saveChange = async (ctx: SavesFns, own: { name: QualifiedName; stored: StoredFnValue; payload: SchedulePayload }, next: SchedulePayload, options: { signature?: TargetSignature | undefined; argsChanged?: boolean } = {}): Promise<{ view: View; version?: number }> => {
    const now = clock.now();
    const viewer = ctx.run.user.timeZone;
    const row = timer.row(own.name);
    const target = options.signature ?? (await shapeOf(ctx, next.fn));
    let firstArgs: Json | undefined;
    try {
      firstArgs = target === undefined ? undefined : await firstArgsOf(ctx, next, target, now, row?.count ?? 0, row?.previous);
    } catch (error) {
      if (!(error instanceof Invalid) || options.argsChanged === true) { throw error; }
    }
    const last = (await lastRuns(ctx, [own.name])).get(own.name);
    if (JSON.stringify(next) === JSON.stringify(own.payload)) {
      return { view: viewOf(own.name, next, { now, viewerZone: viewer, firstArgs, last }) };
    }
    const problems = await payloadProblems(ctx, next, timer.limits.minGap, now);
    if (problems.length > 0) { throw new Invalid(problems); }
    await save(ctx, next, { local: splitName(own.name).local, replace: true, named: true, now });
    return { view: viewOf(own.name, next, { now, viewerZone: viewer, firstArgs, last }), version: own.stored.version };
  };

  return {
    add: {
      run: (args, ctx) => guarded(ctx, async () => {
        const now = clock.now();
        const user = ctx.run.user;
        roomFor(timer, user);
        // only the person lets its runs go ahead: on the approval card (`ctx.approved`), or running add themselves
        const allow = args.allowRuns === true;
        if (allow && ctx.approved === undefined && ctx.run.caller !== user.id) {
          throw new Invalid([{ path: 'allowRuns', message: 'allowRuns is the person\'s own choice, made on the approval card: leave it out.' }]);
        }
        if (allow && timer.limits.approvals === 'refuse') { throw new Refused(REFUSE_SET); }
        const { target, fixed, when, zone } = await addPlan(ctx, args, user);
        const program = await argsProgramOf(ctx, { target: target.name, signature: target.signature, fixed, compute: args.compute, payload: { when, zone }, now, count: 0 });
        const payload = SchedulePayload.parse({ fn: target.name, when, zone, ...program, ...addOptions(args), ...(allow ? { runsAllowed: { at: now, by: user.id } } : {}) });
        const problems = await payloadProblems(ctx, payload, timer.limits.minGap, now);
        if (problems.length > 0) { throw new Invalid(problems); }
        const firstArgs = await firstArgsOf(ctx, payload, target.signature, now, 0, undefined);
        const saved = await save(ctx, payload, { local: localNameOf({ name: args.name, fn: target.name, fixed }), replace: false, named: args.name !== undefined, now });
        if (allow) { await allowRunsOf(ctx, saved.fn, true); }
        ctx.log.info('schedule.added', { fn: saved.fn, target: target.name, runsAllowed: allow });
        return ctx.done(viewOf(saved.fn, payload, { now, viewerZone: user.timeZone, firstArgs }), { undo: { schedule: saved.fn } });
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} is taken back with the save that made it, so it won't run` }),
      preview: (args, ctx) => Promise.resolve(addPreview(args, { user: ctx.user, now: clock.now(), approvals: timer.limits.approvals })),
      // before the card: the person's room for one more, the target, `when`, and fixed args against the target's args
      // type (the first run's args worked out). Args worked out from words wait for the run: that is a model call.
      check: (args, ctx) => checked(async () => {
        const now = clock.now();
        roomFor(timer, ctx.user);
        const { target, fixed, when, zone } = await addPlan(ctx, args, ctx.user);
        const base = { fn: target.name, when, zone, ...addOptions(args) };
        if (args.compute !== undefined) { return whenProblems(base, timer.limits.minGap, now); }
        const wrong = await fixedProblems(fixed ?? {}, target.signature, lookupsOf(ctx));
        if (wrong.length > 0) { return [...wrong, ...whenProblems(base, timer.limits.minGap, now)]; }
        const payload = SchedulePayload.parse({ ...base, args: literalArgs(target.signature, fixed) });
        const problems = await payloadProblems(ctx, payload, timer.limits.minGap, now);
        if (problems.length > 0) { return problems; }
        await firstArgsOf(ctx, payload, target.signature, now, 0, undefined);
        return [];
      }),
    },

    allow_runs: {
      run: (args, ctx) => guarded(ctx, async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.run.user);
        if (ctx.run.caller !== ctx.run.user.id) {
          throw new Refused(`Whether ${own.name}'s runs ask is the person's own choice, made on its page: it can't be changed for them.`);
        }
        if (args.allow && timer.limits.approvals === 'refuse') { throw new Refused(REFUSE_SET); }
        const { runsAllowed: _was, ...rest } = own.payload;
        const next = SchedulePayload.parse(args.allow ? { ...rest, runsAllowed: own.payload.runsAllowed ?? { at: clock.now(), by: ctx.run.user.id } } : rest);
        const { view, version } = await saveChange(ctx, own, next);
        // the hub's policy follows the choice on record (also when only one of them was left behind)
        await allowRunsOf(ctx, own.name, args.allow);
        return version === undefined ? ctx.done(view) : ctx.done(view, { undo: { schedule: own.name, version } });
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} goes back to version ${String(payload.version)}, asking as it did before` }),
    },

    change: {
      run: (args, ctx) => guarded(ctx, async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.run.user);
        const now = clock.now();
        const plan = await changePlan(ctx, own, args);
        let { signature } = plan;
        let program = programOf(own.payload);
        if (args.args !== undefined || args.compute !== undefined) {
          signature ??= (await targetOf(ctx, plan.merged.fn)).signature;
          const row = timer.row(own.name);
          program = await argsProgramOf(ctx, {
            target: plan.merged.fn, signature, fixed: args.args === undefined ? undefined : fromPairs(args.args), compute: args.compute, payload: plan.merged, now, count: row?.count ?? 0, previous: row?.previous,
          });
        }
        const next = changedPayload(plan.merged, program);
        const { view, version } = await saveChange(ctx, own, next, { signature, argsChanged: args.fn !== undefined || args.args !== undefined || args.compute !== undefined });
        return version === undefined ? ctx.done(view) : ctx.done(view, { undo: { schedule: own.name, version } });
      }),
      // before anyone is asked: the schedule is the person's, and what changes reads (the target, `when`, fixed args
      // against the target's args type, the first run's args); args worked out from words wait for the run
      check: (args, ctx) => checked(async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.user);
        const now = clock.now();
        const plan = await changePlan(ctx, own, args);
        if (args.compute !== undefined) { return whenProblems(plan.merged, timer.limits.minGap, now); }
        let signature: TargetSignature | undefined = plan.signature;
        let program = programOf(own.payload);
        if (args.args !== undefined) {
          signature ??= (await targetOf(ctx, plan.merged.fn)).signature;
          const fixed = fromPairs(args.args);
          if (signature.args.name === 'obj' && !isObject(fixed)) { throw new Invalid([{ path: 'args', message: `${plan.merged.fn} takes its args as an object: give them by name.` }]); }
          const wrong = await fixedProblems(fixed, signature, lookupsOf(ctx));
          if (wrong.length > 0) { return [...wrong, ...whenProblems(plan.merged, timer.limits.minGap, now)]; }
          program = { args: literalArgs(signature, fixed) };
        } else if (signature !== undefined && fixedOf(own.payload) !== undefined) {
          // another fn, the same fixed args: they must fit the new fn's args type
          const wrong = await fixedProblems(fixedOf(own.payload) ?? {}, signature, lookupsOf(ctx));
          if (wrong.length > 0) { return wrong; }
        }
        const next = changedPayload(plan.merged, program);
        if (JSON.stringify(next) === JSON.stringify(own.payload)) { return []; }
        const problems = await payloadProblems(ctx, next, timer.limits.minGap, now);
        if (problems.length > 0) { return problems; }
        // what it runs or its args changed: the first run's args must work out, as the run itself requires
        signature ??= args.fn === undefined ? undefined : await shapeOf(ctx, next.fn);
        if (signature !== undefined && (args.fn !== undefined || args.args !== undefined)) {
          const row = timer.row(own.name);
          await firstArgsOf(ctx, next, signature, now, row?.count ?? 0, row?.previous);
        }
        return [];
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} goes back to version ${String(payload.version)}` }),
    },

    list: {
      run: (args, ctx) => guarded(ctx, async () => {
        const now = clock.now();
        const user = ctx.run.user;
        const target = args.fn === undefined ? undefined : nameOf(args.fn);
        const words = (args.search ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '');
        const mine = timer.schedules().filter((fn) => fn.owner === user.id).flatMap((fn) => {
          const payload = SchedulePayload.safeParse(fn.payload);
          if (!payload.success) { return []; }
          if (target !== undefined && payload.data.fn !== target) { return []; }
          if (args.paused !== undefined && (payload.data.paused !== undefined) !== args.paused) { return []; }
          const text = `${fn.fn} ${fn.title} ${payload.data.fn} ${payload.data.argsAsked ?? ''}`.toLowerCase();
          if (!words.every((word) => text.includes(word))) { return []; }
          return [{ name: fn.fn, payload: payload.data }];
        });
        const last = await lastRuns(ctx, mine.map((one) => one.name));
        return ctx.done({ items: mine.map((one) => viewOf(one.name, one.payload, { now, viewerZone: user.timeZone, last: last.get(one.name) })) });
      }),
    },

    pause: {
      run: (args, ctx) => guarded(ctx, async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.run.user, { admin: true });
        const now = clock.now();
        const until = args.until;
        if (until !== undefined && until <= localNow(now, own.payload.zone).day) {
          throw new Invalid([{ path: 'until', message: `${until} is not after today in ${own.payload.zone}: give the day it runs again, or leave it out to pause until it is resumed.` }]);
        }
        const same = own.payload.paused !== undefined && own.payload.paused.until === until;
        const next = same ? own.payload : SchedulePayload.parse({ ...own.payload, paused: { at: now, by: ctx.run.user.id, ...(until === undefined ? {} : { until }) } });
        const { view, version } = await saveChange(ctx, own, next);
        return version === undefined ? ctx.done(view) : ctx.done(view, { undo: { schedule: own.name, version } });
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} goes back to version ${String(payload.version)}, as it was before the pause` }),
    },

    resume: {
      run: (args, ctx) => guarded(ctx, async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.run.user, { admin: true });
        const { paused: _paused, ...rest } = own.payload;
        const { view, version } = await saveChange(ctx, own, SchedulePayload.parse(rest));
        return version === undefined ? ctx.done(view) : ctx.done(view, { undo: { schedule: own.name, version } });
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} goes back to version ${String(payload.version)}, paused again` }),
    },

    skip: {
      run: (args, ctx) => guarded(ctx, async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.run.user);
        const { when, zone } = own.payload;
        const key = OccurrenceKey.parse(occurrenceKey(args.day, args.time));
        const that = firingsOnDays(when, zone, args.day, args.day).filter((firing) => args.time === undefined || firing.key === key);
        if (that.length === 0) {
          const runs = firingsOnDays(when, zone, args.day, args.day);
          throw new Invalid([{
            path: args.time === undefined ? 'day' : 'time',
            message: runs.length === 0
              ? `${own.name} has no run on ${args.day} to skip.`
              : `${own.name} runs on ${args.day} at ${runs.map((run) => run.time ?? '00:00').join(', ')}, not at ${args.time ?? ''}.`,
          }]);
        }
        // a whole day's key skips every run that day; an extra run that day is taken out instead of skipped
        const include = (when.include ?? []).filter((extra) => extra !== key);
        const exclude = include.length === (when.include ?? []).length ? [...new Set([...(when.exclude ?? []), key])] : when.exclude;
        const next = SchedulePayload.parse({ ...own.payload, when: When.parse(jsonOf({ ...when, ...(exclude === undefined || exclude.length === 0 ? {} : { exclude }), ...(include.length === 0 ? { include: undefined } : { include }) })) });
        const { view, version } = await saveChange(ctx, own, next);
        return version === undefined ? ctx.done(view) : ctx.done(view, { undo: { schedule: own.name, version } });
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} goes back to version ${String(payload.version)}: the skipped run is back` }),
    },

    remove: {
      run: (args, ctx) => guarded(ctx, async () => {
        const own = await ownSchedule(ctx, args.schedule, ctx.run.user);
        // a removed schedule leaves no allowance behind for a later one of the same name (undone with the turn)
        if (own.payload.runsAllowed !== undefined) { await allowRunsOf(ctx, own.name, false); }
        try {
          const removed = await ctx.fns.removeFn({ fn: own.name });
          ctx.log.info('schedule.removed', { fn: own.name, version: removed.version });
          return ctx.done({ removed: own.name }, { undo: { schedule: own.name, version: removed.version } });
        } catch (error) {
          if (!(error instanceof CallFailed)) { throw error; }
          throw new Refused(`The hub didn't remove ${own.name}: ${error.message}`);
        }
      }),
      undo: (payload) => Promise.resolve({ status: 'undone', summary: `${payload.schedule} comes back as version ${String(payload.version)} with the hub's removal undone` }),
    },

    history: {
      run: (args, ctx) => guarded(ctx, async () => {
        const name = args.schedule === undefined ? undefined : nameOf(args.schedule);
        if (args.schedule !== undefined && name === undefined) { throw new Invalid([{ path: 'schedule', message: `${args.schedule} is not a schedule's name: ${schedule.fns.list.name} names the person's.` }]); }
        const filters = [
          ...(name === undefined ? [] : [{ field: 'schedule', op: 'is' as const, value: name }]),
          ...(args.status === undefined ? [] : [{ field: 'status', op: 'is' as const, value: args.status satisfies FiringStatus }]),
          ...(args.from === undefined ? [] : [{ field: 'at', op: 'gte' as const, value: args.from.getTime() }]),
          ...(args.to === undefined ? [] : [{ field: 'at', op: 'lt' as const, value: args.to.getTime() }]),
        ];
        const page = await ctx.data.find(schedule.types.Firing, { query: { filters, sort: [{ field: 'at', dir: 'desc' }], limit: HISTORY_PAGE } });
        const items = page.items.map((record) => FiringShape.parse(record.value));
        return ctx.done({ items, ...(page.cursor === undefined ? {} : { cursor: page.cursor }) });
      }),
    },

    remind: {
      run: async (args, ctx) => {
        await ctx.notify({ title: 'Reminder', body: args.text, tone: 'info' });
        return ctx.done({ sent: true });
      },
    },
  };
}
