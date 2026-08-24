import type { ProfileScope } from "@liberty/auth";
import { and, desc, eq, sql } from "drizzle-orm";
import type { LibertyDatabase } from "./client";
import { type PlaybackProgressRow, parseContentId } from "./contracts";
import { playbackProgress } from "./schema";
import {
  FIRST_WRITER_EPOCH,
  type ProgressWrite,
  type ProgressWriteResolution,
  type StoredProgress,
  representableInstant,
  resolveProgressWrite
} from "./writer-epoch";

/* -------------------------------------------------------------------------
 * Progress persistence (PL-0403)
 *
 * Every function takes a `ProfileScope`. There is no overload that accepts a
 * `profileId` string, and every statement carries `profile_id = scope.profileId`
 * in its WHERE or its conflict target. Profile scoping is therefore enforced in
 * three independent places -- the type of the argument, the SQL predicate, and
 * the primary key itself -- and no single mistake defeats all three.
 *
 * DIRECT TO POSTGRESQL. No queue, no Redis, no write-behind. The research is
 * explicit that write-behind waits for a MEASURED PostgreSQL problem, and the
 * cheap lever (client-side coalescing) is `heartbeat.ts`.
 *
 * WHERE THE CONFLICT IS ACTUALLY DECIDED. The guard lives in the SQL, as a
 * conditional `UPDATE ... WHERE writer_epoch = $ AND writer_id = $ AND
 * write_seq < $`, so two concurrent writes are serialised by PostgreSQL rather
 * than by a read-then-write in application code, which would have a lost-update
 * window between the two statements. `resolveProgressWrite` is then used to
 * EXPLAIN a guard that did not match: the same rules, evaluated against the row
 * as it now stands, producing the reason the write lost. Explanation and
 * enforcement are the same policy expressed twice on purpose -- the SQL half
 * cannot be unit-tested without a database, and the pure half can.
 * ---------------------------------------------------------------------- */

/** The row, reduced to what the pure resolver reads. */
function toStored(row: PlaybackProgressRow): StoredProgress {
  return {
    positionSeconds: row.positionSeconds,
    runtimeSeconds: row.runtimeSeconds,
    writerEpoch: row.writerEpoch,
    writerId: row.writerId,
    writeSeq: row.writeSeq,
    updatedAt: row.updatedAt.toISOString()
  };
}

export type ProgressRepositoryFailure =
  | { readonly ok: false; readonly reason: "not_a_normalized_content_id"; readonly detail: string }
  /**
   * Shares its name with the resolver's refusal on purpose: it is the same
   * defect -- a caller-supplied moment that is not one -- caught on the path
   * that has no resolver to catch it.
   */
  | { readonly ok: false; readonly reason: "instant_not_representable"; readonly detail: string };

/**
 * Take over playback of a title on this device.
 *
 * The epoch is incremented INSIDE the statement (`writer_epoch + 1` reads the
 * stored value in the same atomic update that writes the new one), so two
 * devices asking at the same instant are serialised by PostgreSQL and receive
 * distinct epochs. Computing the increment in TypeScript and writing it back
 * would be the lost-update race this whole mechanism exists to avoid, one layer
 * up.
 *
 * `write_seq` resets to 0 with each lease, which is why a sequence number is
 * only ever compared within an epoch.
 */
export async function issueWriterLease(
  db: LibertyDatabase,
  input: {
    readonly scope: ProfileScope;
    readonly contentId: string;
    readonly writerId: string;
    readonly instant: Date;
  }
): Promise<{ readonly ok: true; readonly epoch: number; readonly writerId: string } | ProgressRepositoryFailure> {
  const contentId = parseContentId(input.contentId);
  if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

  // The same hole `writeProgress` has, on the one path that never reaches
  // `resolveProgressWrite`. An Invalid Date reaching the INSERT is not caught by
  // anything downstream: the driver serialises it into a timestamp literal
  // PostgreSQL cannot read, so the whole lease request fails as a driver error
  // naming a column, at a stack depth that says nothing about the caller who
  // built the date. Refused here, with the reason the resolver would have given.
  if (representableInstant(input.instant) === null) {
    return { ok: false, reason: "instant_not_representable", detail: String(input.instant) };
  }

  const rows = await db
    .insert(playbackProgress)
    .values({
      profileId: input.scope.profileId,
      contentId: contentId.contentId,
      positionSeconds: 0,
      runtimeSeconds: null,
      writerEpoch: FIRST_WRITER_EPOCH,
      writerId: input.writerId,
      writeSeq: 0,
      updatedAt: input.instant
    })
    .onConflictDoUpdate({
      target: [playbackProgress.profileId, playbackProgress.contentId],
      set: {
        writerEpoch: sql`${playbackProgress.writerEpoch} + 1`,
        writerId: input.writerId,
        writeSeq: 0
        // `position_seconds` and `updated_at` are NOT touched. Taking over
        // playback must not move the resume point or make an untouched title
        // look freshly watched in "continue watching" -- the lease is a claim
        // on the right to write, not a write.
      }
    })
    .returning({ epoch: playbackProgress.writerEpoch, writerId: playbackProgress.writerId });

  const row = rows[0];
  if (row === undefined) throw new Error("writer lease upsert returned no row");
  return { ok: true, epoch: row.epoch, writerId: row.writerId };
}

/**
 * Record a position.
 *
 * Returns the same `ProgressWriteResolution` the pure resolver produces, so a
 * refusal reaches the caller as a reason code rather than as a silent no-op --
 * "your write was ignored" with no explanation is precisely the debugging
 * nightmare a two-device handoff produces.
 */
export async function writeProgress(
  db: LibertyDatabase,
  input: {
    readonly scope: ProfileScope;
    readonly contentId: string;
    readonly write: ProgressWrite;
    readonly instant: Date;
  }
): Promise<ProgressWriteResolution | ProgressRepositoryFailure> {
  const contentId = parseContentId(input.contentId);
  if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

  const key = and(
    eq(playbackProgress.profileId, input.scope.profileId),
    eq(playbackProgress.contentId, contentId.contentId)
  );

  // Read first, and use the read ONLY to explain. The authority is still the
  // guarded UPDATE below: if another device wins between these two statements,
  // the guard does not match and the second read produces the real reason. What
  // the pre-read buys is the accepted branch's notes -- `retained_known_runtime`
  // and `position_moved_backwards` describe the row as it was BEFORE the write,
  // and `UPDATE ... RETURNING` in PostgreSQL returns the row after it.
  const before = await db.select().from(playbackProgress).where(key).limit(1);
  const beforeRow = before[0];
  // The `Date` is handed over unconverted. Calling `toISOString()` here would
  // throw `RangeError` on an Invalid Date -- which is what `new Date(x)` returns
  // for any `x` it cannot read -- and that exception would escape this function
  // as a 500 with no reason. The resolver refuses such an instant by name, and
  // the refusal returns below through the same path as every other one.
  const predicted = resolveProgressWrite({
    stored: beforeRow === undefined ? null : toStored(beforeRow),
    write: input.write,
    instant: input.instant
  });

  // A write the rules already refuse is not attempted. The guard would refuse
  // it too, and skipping the statement keeps a superseded device's heartbeats
  // from taking a write lock on a row it can never change.
  if (!predicted.accepted) return predicted;

  const updated = await db
    .update(playbackProgress)
    .set({
      positionSeconds: input.write.positionSeconds,
      // An unknown runtime must not overwrite a known one -- PL-0205's rule,
      // expressed in SQL by COALESCE so the guarded update stays a single
      // statement. `resolveProgressWrite` applies the identical rule, and
      // `writer-epoch.test.ts` is where it is actually verified.
      runtimeSeconds: sql`COALESCE(${input.write.runtimeSeconds}, ${playbackProgress.runtimeSeconds})`,
      writeSeq: input.write.writeSeq,
      updatedAt: input.instant
    })
    .where(
      and(
        key,
        eq(playbackProgress.writerEpoch, input.write.lease.epoch),
        eq(playbackProgress.writerId, input.write.lease.writerId),
        sql`${playbackProgress.writeSeq} < ${input.write.writeSeq}`
      )
    )
    .returning();

  // The guard matched, so the prediction stands and its notes describe the
  // transition that actually happened.
  if (updated[0] !== undefined) return predicted;

  // The guard did not match, which means the row changed under us between the
  // read and the update -- another device took the lease. Re-read and let the
  // pure resolver say why: superseded, forged epoch, wrong writer and a
  // replayed packet are four different findings, and "update affected 0 rows"
  // is none of them.
  const current = await db.select().from(playbackProgress).where(key).limit(1);
  const stored = current[0];
  return resolveProgressWrite({
    stored: stored === undefined ? null : toStored(stored),
    write: input.write,
    instant: input.instant
  });
}

/** The resume point for one title. */
export async function readProgress(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope; readonly contentId: string }
): Promise<PlaybackProgressRow | null | ProgressRepositoryFailure> {
  const contentId = parseContentId(input.contentId);
  if (!contentId.ok) return { ok: false, reason: contentId.reason, detail: contentId.detail };

  const rows = await db
    .select()
    .from(playbackProgress)
    .where(
      and(
        eq(playbackProgress.profileId, input.scope.profileId),
        eq(playbackProgress.contentId, contentId.contentId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * "Continue watching" for one profile.
 *
 * `limit` is required rather than defaulted. An unbounded list query against a
 * table that grows with every episode a household watches is a slow request
 * waiting for a heavy user, and a default would hide the decision from the call
 * site that has to live with it.
 */
export async function listContinueWatching(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope; readonly limit: number }
): Promise<readonly PlaybackProgressRow[]> {
  return db
    .select()
    .from(playbackProgress)
    .where(eq(playbackProgress.profileId, input.scope.profileId))
    // `contentId` breaks ties so the page is a total order. Two rows updated in
    // the same millisecond otherwise come back in whatever order the plan
    // chose, which makes a paginated list skip and repeat entries.
    .orderBy(desc(playbackProgress.updatedAt), desc(playbackProgress.contentId))
    .limit(input.limit);
}
