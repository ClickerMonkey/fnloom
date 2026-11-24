/**
 * What the timer keeps in its own SQLite file in the instance's data folder, beside its `@ayepi/work` queue: one row
 * per schedule (its version, the last firing instant it handled, the firing queued next, the refusal last told, the
 * last firing that ran for `previous`, how many firings came before, an overlap-queued firing) and one row per recent
 * firing (its status, run, record and whether its owner was told), which maps a settled run back to its firing and
 * counts a person's firings in a day.
 *
 * The firing records themselves are the hub's (`schedule/Firing`, the owner's); these rows are rebuilt from those
 * records and `kindFns` when the data folder is lost (only firings not yet recorded are lost then).
 */
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { ActorId, QualifiedName, RecordId, RunId } from '@harness/core';
import { FiringShape, FiringStatus, OccurrenceKey, PreviousFiring } from '../shared/types.ts';

/** A schedule as the timer knows it. */
export const ScheduleRow = z.object({
  fn: QualifiedName,
  owner: ActorId,
  version: z.number().int(),
  /** The latest planned instant handled (fired, missed or skipped), or when the timer first saw it. */
  lastAt: z.number().int(),
  /** The instant of the firing queued next; absent when nothing is queued (paused, or it ends). */
  plannedAt: z.number().int().optional(),
  /** The refusal reason last told, so one reason is told once until a firing runs again. */
  refused: z.string().optional(),
  /** The refusal reason the admins were last told (its owner is gone), kept apart from the owner's so neither is told twice. */
  adminsTold: z.string().optional(),
  /** The last firing that ran or failed, for the args program's `previous`. */
  previous: PreviousFiring.optional(),
  /** Firings that became runs. */
  count: z.number().int().min(0),
  /** A firing waiting for the running one to settle (overlap `queue`). */
  queued: z.object({ at: z.number().int(), key: OccurrenceKey }).optional(),
  /** When its old firing records were last pruned. */
  prunedAt: z.number().int().optional(),
});
export type ScheduleRow = z.infer<typeof ScheduleRow>;

/** Why the schedule's own rules ended a firing's run (rather than the run itself): it shows in its status and summary. */
export const EndReason = z.enum(['replaced', 'expired', 'refused']);
export type EndReason = z.infer<typeof EndReason>;

/** One recent firing as the timer tracks it. */
export const FiringRow = z.object({
  /** `<fn>@<instant>` for a planned firing, `<fn>@run:<run>` for "run now". */
  id: z.string(),
  fn: QualifiedName,
  owner: ActorId,
  at: z.number().int(),
  status: FiringStatus,
  /** The schedule run the firing became. */
  run: RunId.optional(),
  /** Its `schedule/Firing` record. */
  record: RecordId.optional(),
  /** The record's value as last saved. */
  value: FiringShape,
  /** While waiting for approval: when it gives up. */
  until: z.number().int().optional(),
  /** Missed firings found with it (it ran late after them): its notice says so. */
  missed: z.number().int().min(0),
  /** Why the schedule's rules ended its run. */
  reason: EndReason.optional(),
  /** Its person (or the run above it) cancelled it. */
  byPerson: z.boolean(),
  /** Whether telling its owner was decided (sent, or not to be sent). */
  told: z.boolean(),
  created: z.number().int(),
});
export type FiringRow = z.infer<typeof FiringRow>;

/** A row of a value column, as SQLite gives it. */
const ValueRow = z.object({ value: z.string() });
const ValueRows = z.array(ValueRow);
const IdRows = z.array(z.object({ id: z.string(), value: z.string() }));
const CountRow = z.object({ n: z.number() });

/** The statuses of a firing that is still going. */
const ACTIVE: readonly FiringStatus[] = ['running', 'waiting'];

/** The timer's tables on one SQLite connection (better-sqlite3, synchronous). */
export class TimerStore {
  readonly db: BetterSqlite3.Database;

  constructor(file: string) {
    this.db = new BetterSqlite3(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (fn TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS firings (
        id TEXT PRIMARY KEY, fn TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL,
        run TEXT, created INTEGER NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS firings_run ON firings (run);
      CREATE INDEX IF NOT EXISTS firings_fn ON firings (fn, status);
      CREATE INDEX IF NOT EXISTS firings_owner ON firings (owner, created);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ─── schedules ──────────────────────────────────────────────────────────────

  schedule(fn: string): ScheduleRow | undefined {
    const row = ValueRow.optional().parse(this.db.prepare('SELECT value FROM schedules WHERE fn = ?').get(fn));
    return row === undefined ? undefined : ScheduleRow.parse(JSON.parse(row.value));
  }

  schedules(): ScheduleRow[] {
    const rows = ValueRows.parse(this.db.prepare('SELECT value FROM schedules ORDER BY fn').all());
    return rows.map((row) => ScheduleRow.parse(JSON.parse(row.value)));
  }

  putSchedule(row: ScheduleRow): ScheduleRow {
    const value = ScheduleRow.parse(row);
    this.db.prepare('INSERT INTO schedules (fn, value) VALUES (?, ?) ON CONFLICT(fn) DO UPDATE SET value = excluded.value').run(value.fn, JSON.stringify(value));
    return value;
  }

  /** Change a schedule's row; nothing when there is none. */
  updateSchedule(fn: string, change: (row: ScheduleRow) => ScheduleRow): ScheduleRow | undefined {
    const row = this.schedule(fn);
    return row === undefined ? undefined : this.putSchedule(change(row));
  }

  removeSchedule(fn: string): void {
    this.db.prepare('DELETE FROM schedules WHERE fn = ?').run(fn);
  }

  // ─── firings ────────────────────────────────────────────────────────────────

  firing(id: string): FiringRow | undefined {
    const row = ValueRow.optional().parse(this.db.prepare('SELECT value FROM firings WHERE id = ?').get(id));
    return row === undefined ? undefined : FiringRow.parse(JSON.parse(row.value));
  }

  firingByRun(run: string): FiringRow | undefined {
    const row = ValueRow.optional().parse(this.db.prepare('SELECT value FROM firings WHERE run = ?').get(run));
    return row === undefined ? undefined : FiringRow.parse(JSON.parse(row.value));
  }

  putFiring(row: FiringRow): FiringRow {
    const value = FiringRow.parse(row);
    this.db.prepare(`
      INSERT INTO firings (id, fn, owner, at, status, run, created, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, run = excluded.run, value = excluded.value
    `).run(value.id, value.fn, value.owner, value.at, value.status, value.run ?? null, value.created, JSON.stringify(value));
    return value;
  }

  /** Change a firing's row; nothing when there is none. */
  updateFiring(id: string, change: (row: FiringRow) => FiringRow): FiringRow | undefined {
    const row = this.firing(id);
    return row === undefined ? undefined : this.putFiring(change(row));
  }

  removeFiring(id: string): void {
    this.db.prepare('DELETE FROM firings WHERE id = ?').run(id);
  }

  /** The schedule's firing still going (running or waiting), if one is. */
  active(fn: string): FiringRow | undefined {
    const row = ValueRow.optional().parse(this.db.prepare(`SELECT value FROM firings WHERE fn = ? AND status IN (${ACTIVE.map(() => '?').join(', ')}) ORDER BY at DESC LIMIT 1`).get(fn, ...ACTIVE));
    return row === undefined ? undefined : FiringRow.parse(JSON.parse(row.value));
  }

  /** Every firing still going. */
  allActive(): FiringRow[] {
    const rows = ValueRows.parse(this.db.prepare(`SELECT value FROM firings WHERE status IN (${ACTIVE.map(() => '?').join(', ')})`).all(...ACTIVE));
    return rows.map((row) => FiringRow.parse(JSON.parse(row.value)));
  }

  /** Settled firings whose telling wasn't decided yet (the system stopped between the two). */
  untold(): FiringRow[] {
    const rows = ValueRows.parse(this.db.prepare(`SELECT value FROM firings WHERE status NOT IN (${ACTIVE.map(() => '?').join(', ')})`).all(...ACTIVE));
    return rows.map((row) => FiringRow.parse(JSON.parse(row.value))).filter((row) => !row.told);
  }

  /** How many firings of a person's became runs since a time (the firings-per-day limit). */
  startedSince(owner: string, since: number): number {
    const row = CountRow.parse(this.db.prepare('SELECT COUNT(*) AS n FROM firings WHERE owner = ? AND created >= ? AND run IS NOT NULL').get(owner, since));
    return row.n;
  }

  /** Forget settled firings older than a time whose telling was decided (their records stay in the hub). */
  forgetBefore(before: number): void {
    const rows = IdRows.parse(this.db.prepare(`SELECT id, value FROM firings WHERE created < ? AND status NOT IN (${ACTIVE.map(() => '?').join(', ')})`).all(before, ...ACTIVE));
    for (const row of rows) {
      if (FiringRow.parse(JSON.parse(row.value)).told) { this.removeFiring(row.id); }
    }
  }
}
