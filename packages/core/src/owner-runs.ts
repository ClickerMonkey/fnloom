/**
 * Runs a system starts by itself, as the owners of its kinds' fns, and the notices it sends people (`runs` grant,
 * `ctx.runs` and `ctx.notify` in the SDK). Outside any run a system may list the fns of its own kinds (`kindFns`),
 * start one as its owner in a sessionless turn (`startRun`, idempotent by `key`) and tell that owner how it went
 * (`notifyOwner`); inside a run it may tell the run's own person something (`notify`). None of it reaches anyone else.
 */
import { z } from 'zod';
import { ActorId, Json, Priority, QualifiedName, RunId, Timestamp, TurnId, Usd } from './primitives.ts';
import { NOTIFICATION_KEY, NotificationAlso, NotificationLink, NotificationTone } from './records/content.ts';
import { RunStatus } from './run.ts';

/** The most fns `kindFns` gives in one page. */
export const KIND_FNS_PAGE = 100;

/** The most characters a notice's title holds. */
export const NOTICE_TITLE = 120;

/** The most characters a notice's body may be sent with; the hub clamps what it keeps to `NOTIFICATION_BODY`. */
export const NOTICE_BODY_SENT = 2000;

/** Which of a system's kind fns `kindFns` lists: those of one of its kinds, a page at a time. */
export const KindFnsQuery = z.object({
  /** One of the asking system's own kinds (`schedule/schedule`). */
  kind: QualifiedName,
  /** Only fns saved (or whose availability moved) at or after this, and those removed since. */
  changedSince: Timestamp.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(KIND_FNS_PAGE).optional(),
});
export type KindFnsQuery = z.infer<typeof KindFnsQuery>;

/** A fn of one of a system's kinds as the hub lists it: its owner, title, version and payload (JSON: the SDK parses it). */
export const KindFnWire = z.object({
  fn: QualifiedName,
  kind: QualifiedName,
  /** The person who owns it: whom its runs are started as and whom `notifyOwner` reaches. */
  owner: ActorId,
  /** What people call it ("Weekly sales summary"). */
  title: z.string(),
  /** Its version, from 1, counting every save. */
  version: z.number().int().min(1),
  payload: Json,
  /** Removed since `changedSince` (its last version's payload is given). */
  removed: z.boolean(),
  updatedAt: Timestamp,
});
export type KindFnWire = z.infer<typeof KindFnWire>;

/** One page of `kindFns`. */
export const KindFnsPage = z.object({ items: z.array(KindFnWire), cursor: z.string().optional() });
export type KindFnsPage = z.infer<typeof KindFnsPage>;

/** The most characters a start key holds. */
export const START_KEY = 200;

/** A run of a kind's fn, started by its system as the fn's owner (`startRun`). */
export const StartAsOwner = z.object({
  /** The fn: one of the asking system's own kinds'. */
  fn: QualifiedName,
  /** Checked by the hub against the args its kind's `describe` gives the fn. */
  args: Json,
  /** The same key is the same run: a retried or doubled start returns the first one's run, never a second. */
  key: z.string().min(1).max(START_KEY),
  /** Default `background`, so people's chats go first. */
  priority: Priority.extract(['background', 'interactive']).optional(),
  /** The most the run may spend: lowers the turn's own budget. */
  maxSpend: Usd.positive().optional(),
});
export type StartAsOwner = z.infer<typeof StartAsOwner>;

/** The run `startRun` started (or had already started under the same key), its turn, and its status now. */
export const StartedRun = z.object({ run: RunId, turn: TurnId, status: RunStatus });
export type StartedRun = z.infer<typeof StartedRun>;

/**
 * A notice a system sends one person: the run's (`notify`) or a kind fn's owner (`notifyOwner`). Its links may lead to
 * a run of that person's or to one of the system's own pages; the hub refuses any other. `body` longer than
 * `NOTIFICATION_BODY` is clamped on a word boundary.
 */
export const SystemNotice = z.object({
  title: z.string().min(1).max(NOTICE_TITLE),
  body: z.string().max(NOTICE_BODY_SENT),
  tone: NotificationTone.optional(),
  link: NotificationLink.optional(),
  also: NotificationAlso.optional(),
  /** A later notice of the same key from the same system replaces this one while it is unread (and is its push tag). */
  key: z.string().min(1).max(NOTIFICATION_KEY - 64).optional(),
});
export type SystemNotice = z.infer<typeof SystemNotice>;
