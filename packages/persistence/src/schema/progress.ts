import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp
} from "drizzle-orm/pg-core";
import { profile } from "./profiles";

/* -------------------------------------------------------------------------
 * Playback progress (PL-0403)
 *
 * SCOPED TO `profileId`, NOT TO A USER ID. The research names this as the
 * decision that is expensive to reverse, so it is in the first migration. The
 * retrofit that is being avoided is not a schema edit -- adding a column is
 * easy. It is the BACKFILL: once a household has a year of progress rows keyed
 * by account, there is no information anywhere that says which of the four
 * people in that household watched which episode, and the data is unrecoverable
 * rather than merely unmigrated.
 *
 * KEYED BY `(profileId, contentId)`, which makes a repeated write an UPSERT
 * rather than an insert-or-update race. PostgreSQL's
 * `INSERT ... ON CONFLICT DO UPDATE` is the concurrency primitive; there is no
 * read-modify-write in the repository and therefore no lost-update window
 * between the read and the write.
 *
 * NO REDIS. Writes go straight here. Redis write-behind is not forbidden
 * forever -- it is forbidden until a PostgreSQL problem has been MEASURED,
 * because at-least-once handoff buys replay and reconciliation complexity and
 * `appendfsync everysec` can still lose a window of writes. The first lever is
 * write coalescing on the client, which is `heartbeat.ts` and costs nothing
 * operationally.
 * ---------------------------------------------------------------------- */

export const playbackProgress = pgTable(
  "playback_progress",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    /** The normalized content id from `@liberty/contracts`. */
    contentId: text("content_id").notNull(),

    /**
     * Whole seconds, not a float and not milliseconds.
     *
     * Seconds because a resume point finer than a second is not perceptible and
     * a float would make "is this the same position" a tolerance question in
     * every test. An integer column also means the CHECK constraints below are
     * exact.
     */
    positionSeconds: integer("position_seconds").notNull(),
    /**
     * Total runtime as known when this row was written, or null when the
     * playback source never stated one.
     *
     * NULL means UNKNOWN and never zero. This is the same invariant PL-0205
     * establishes for media facts: an absent duration must not be inferred, and
     * a zero here would make every title look 100% complete.
     */
    runtimeSeconds: integer("runtime_seconds"),

    /* --- the writer epoch, and why it is three columns --- */

    /**
     * SERVER-ISSUED. Incremented by the server every time a device takes over
     * playback of this title; never supplied by a client. This is the column
     * that decides which of two devices is current, and it works because its
     * value comes from the server rather than from data the client controls.
     */
    writerEpoch: bigint("writer_epoch", { mode: "number" }).notNull(),
    /**
     * The identity of the writer holding that epoch. Paired with the epoch so
     * that an epoch number is not on its own sufficient to write: guessing "the
     * current epoch is probably 7" gets a `writer_id_mismatch` denial rather
     * than a successful clobber.
     */
    writerId: text("writer_id").notNull(),
    /**
     * A per-writer counter, monotonic WITHIN one epoch.
     *
     * Solves a different problem from the epoch: two packets from the SAME
     * device can arrive out of order, and both carry the same epoch and writer.
     * Crucially this is not a rule about POSITION -- it is a rule about
     * sequence, so a rewind still has a higher sequence number and is still
     * accepted. That distinction is the whole reason the rejected
     * "monotonically increasing position" rule was rejected.
     */
    writeSeq: bigint("write_seq", { mode: "number" }).notNull(),

    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.contentId] }),
    /**
     * "Continue watching" is `WHERE profile_id = $1 ORDER BY updated_at DESC`,
     * which is the only list query this table serves. Indexed on the profile
     * FIRST so the index is unusable for a scan that forgot to scope.
     */
    index("playback_progress_profile_updated_idx").on(table.profileId, table.updatedAt),
    check("playback_progress_position_non_negative", sql`${table.positionSeconds} >= 0`),
    /**
     * A stated runtime must be positive, and a position may not exceed it. The
     * database refuses these rather than the application alone, because a
     * position past the end of the media is not a rendering glitch -- it is a
     * row that will make the title resume at a point that does not exist.
     */
    check(
      "playback_progress_runtime_positive",
      sql`${table.runtimeSeconds} IS NULL OR ${table.runtimeSeconds} > 0`
    ),
    check(
      "playback_progress_position_within_runtime",
      sql`${table.runtimeSeconds} IS NULL OR ${table.positionSeconds} <= ${table.runtimeSeconds}`
    ),
    check("playback_progress_epoch_positive", sql`${table.writerEpoch} >= 1`),
    check("playback_progress_seq_non_negative", sql`${table.writeSeq} >= 0`)
  ]
);
