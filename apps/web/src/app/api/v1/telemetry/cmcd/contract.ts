import { CMCD_REPORT_LIMITS } from "@liberty/observability";
import { z } from "zod";

/* -------------------------------------------------------------------------
 * The CMCD collector wire contract (PL-0503)
 *
 * WHY THIS LIVES HERE AND NOT IN `@liberty/contracts`. The same reason
 * `api/v1/playback/session/contract.ts` gives, which is still the current one:
 * that package is under a lock held by other in-flight work, a second editor
 * there produces a merge conflict in the module every lane compiles against,
 * and the move is mechanical because nothing below imports anything from this
 * app. `packages/observability/src/cmcd-report.ts` records the same decision
 * from the other end.
 *
 * WHAT A CALLER GETS. One of two outcomes discriminated on `outcome`, with
 * `reasons` NON-EMPTY on both branches, built the same way the playback session
 * response is: a non-empty tuple, constructed only through factory functions
 * that take the primary reason as a required positional argument, validated
 * against this schema on the way out. Product invariant 4 is not narrower for a
 * telemetry endpoint than for a playback one — "we dropped your report" with no
 * reason is exactly the state that makes an observability pipeline unfalsifiable.
 *
 * WHAT THE RESPONSE DELIBERATELY DOES NOT CARRY. Nothing derived from the
 * request body. No key names, no values, no offsets into the input, no parse
 * error text. A refusal is `{ reason, count }`, which is the operationally
 * useful shape and is also the only shape that cannot echo an unauthenticated
 * client's bytes back out — the rule `CmcdRejection` already states, applied to
 * the HTTP layer that would otherwise be the hole in it.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Request
 * ---------------------------------------------------------------------- */

/**
 * The two bodies this endpoint accepts, and why there are two.
 *
 * `application/cmcd` is Shaka's Event Mode: newline-delimited RFC 8941
 * dictionaries, decoded by `cmcd-sfv.ts`. It is the only thing the player's
 * CMCD reporter can send.
 *
 * `application/json` is for the first-party diagnostics that the CMCD reporter
 * structurally cannot carry — PL-0504's `com.liberty-avs-*` proxies, which are
 * CTA-5004-B CUSTOM keys, and shaka-player 5.2.6 offers no API to add a custom
 * key to its own reports. It is the same decoded envelope
 * `readCmcdEventReport` already takes, so it enters the identical allowlist,
 * redaction and unit path: a JSON body is not a second collector, it is a second
 * spelling of the same one.
 *
 * ANY OTHER MEDIA TYPE IS REFUSED, not sniffed. A collector that guesses at an
 * unlabelled body is a collector that will one day parse a form post as a
 * report.
 */
export const CMCD_REPORT_MEDIA_TYPE = "application/cmcd";
export const CMCD_JSON_REPORT_MEDIA_TYPE = "application/json";

/**
 * The JSON envelope, strict on both levels.
 *
 * `.strict()` is the enforcement and not decoration, for the reason the
 * playback session request states: zod's default is to STRIP unknown keys, so a
 * client posting `{ events, userId }` would get a cheerful 202 and no
 * indication that the field it believed in was discarded — and the next person
 * to extend this schema would be one keystroke from honouring it. On a
 * telemetry endpoint that field is exactly the one that must never exist:
 * CMCD's `sid` and `cid` are the only identifiers this system accepts, and a
 * top-level field beside them is how a user identifier would arrive.
 *
 * The event objects themselves are NOT strict, and could not be: their key
 * space is the CMCD registry plus namespaced custom keys, and `cmcd-collect.ts`
 * is the allowlist for it. Restating that here would be a second vocabulary.
 */
export const cmcdJsonReportSchema = z
  .object({
    events: z.array(z.record(z.string(), z.unknown())).max(CMCD_REPORT_LIMITS.maxEvents)
  })
  .strict();

export type CmcdJsonReport = z.infer<typeof cmcdJsonReportSchema>;

/* -------------------------------------------------------------------------
 * Reasons
 * ---------------------------------------------------------------------- */

/**
 * The closed reason vocabulary.
 *
 * A CODE RATHER THAN A SENTENCE, for the reason `domains/failover.ts` spells
 * out: the moment a consumer decides anything by matching substrings of prose, a
 * reworded message is a behaviour change no type, test or review can see.
 * `detail` beside it is for humans and is never parsed.
 */
export const cmcdCollectorReasonCodeSchema = z.enum([
  /* The report was taken. */
  "report_collected",
  /* Request-level: nothing was decoded because the request itself is not one. */
  "content_type_not_supported",
  "body_too_large",
  "body_unreadable",
  "field_not_permitted",
  "report_envelope_invalid",
  /* Body-level: the request was well formed and carried nothing usable. */
  "body_empty",
  "body_not_decodable"
]);

export type CmcdCollectorReasonCode = z.infer<typeof cmcdCollectorReasonCodeSchema>;

export const cmcdCollectorReasonSchema = z.object({
  code: cmcdCollectorReasonCodeSchema,
  detail: z.string().min(1)
});

export type CmcdCollectorReason = z.infer<typeof cmcdCollectorReasonSchema>;

const reasonsSchema = z.array(cmcdCollectorReasonSchema).nonempty();

export function cmcdCollectorReason(
  code: CmcdCollectorReasonCode,
  detail: string
): CmcdCollectorReason {
  return { code, detail: detail.trim() === "" ? code : detail };
}

/**
 * One refusal, from whichever stage made it.
 *
 * `stage` is carried because the two vocabularies answer different questions
 * and a reader has to be able to tell them apart: `decode` means the BYTES were
 * not a well-formed CMCD report, `collect` means they were and the CMCD
 * VOCABULARY refused something in them. A client that gets `decode` refusals has
 * an encoder bug; a client that gets `collect` refusals has a key problem.
 *
 * `reason` is `z.string()` rather than an enum ON PURPOSE. The collect-stage
 * vocabulary is `CmcdRejectionReason` in `@liberty/observability`, which is a
 * TYPE and has no runtime enumeration to import. Re-spelling its fifteen members
 * here would be a hand-copied list that drifts the first time that package gains
 * a sixteenth — a second opinion about somebody else's closed vocabulary, which
 * is the thing this repository keeps refusing to create. Every value that
 * reaches this field is produced by our own code, never by the client, so the
 * looser schema admits nothing a closed one would have caught.
 */
export const cmcdCollectorRefusalSchema = z.object({
  stage: z.enum(["decode", "collect"]),
  reason: z.string().min(1),
  /** Populated only for keys the CMCD registry recognises. Never client text. */
  key: z.string().min(1).nullable(),
  count: z.number().int().positive()
});

export type CmcdCollectorRefusal = z.infer<typeof cmcdCollectorRefusalSchema>;

/* -------------------------------------------------------------------------
 * The response
 * ---------------------------------------------------------------------- */

/**
 * Two outcomes, and `refusals` on both.
 *
 *   - `collected`  -- at least one event became a structured record. Some keys
 *                     or events may still have been refused; that is the
 *                     ordinary case and `refusals` is where it is said.
 *   - `refused`    -- nothing was collected, and `reasons[0]` is why.
 *
 * A PARTIAL SUCCESS IS A SUCCESS, and it is not silent. The alternative --
 * failing a batch because one event in it was malformed -- is the behaviour
 * `readCmcdEventReport` already rejects one layer down, for the same reason:
 * losing thirty real measurements to one bad entry is what makes people turn
 * telemetry off.
 */
export const cmcdCollectorResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("collected"),
    accepted: z.number().int().positive(),
    reasons: reasonsSchema,
    refusals: z.array(cmcdCollectorRefusalSchema)
  }),
  z.object({
    outcome: z.literal("refused"),
    /* Literally zero. `refused` means nothing was recorded, and a non-zero
     * count on this branch would be a response contradicting itself. */
    accepted: z.literal(0),
    reasons: reasonsSchema,
    refusals: z.array(cmcdCollectorRefusalSchema)
  })
]);

export type CmcdCollectorResponse = z.infer<typeof cmcdCollectorResponseSchema>;

type NonEmptyReasons = [CmcdCollectorReason, ...CmcdCollectorReason[]];

/**
 * `[head, ...rest]` typed as the non-empty tuple the schema requires.
 *
 * The assertion states the tuple rather than leaning on the contextual type to
 * infer it, exactly as `playback/session/contract.ts` does and for the same
 * reason. It cannot be wrong: `head` is non-optional and the spread follows it.
 */
function trail(head: CmcdCollectorReason, rest: CmcdCollectorReason[]): NonEmptyReasons {
  return [head, ...rest] as NonEmptyReasons;
}

export function collectedReport(
  accepted: number,
  refusals: readonly CmcdCollectorRefusal[],
  primary: CmcdCollectorReason,
  ...rest: CmcdCollectorReason[]
): CmcdCollectorResponse {
  return { outcome: "collected", accepted, reasons: trail(primary, rest), refusals: [...refusals] };
}

export function refusedReport(
  refusals: readonly CmcdCollectorRefusal[],
  primary: CmcdCollectorReason,
  ...rest: CmcdCollectorReason[]
): CmcdCollectorResponse {
  return { outcome: "refused", accepted: 0, reasons: trail(primary, rest), refusals: [...refusals] };
}

/**
 * The HTTP status for a decision.
 *
 * THE STATUS CODES ARE READ BY THE CLIENT'S RETRY LOOP, and that is not a
 * guess about clients in general -- it is what shaka-player 5.2.6's vendored
 * `third_party/cml-cmcd/cmcd_reporter.js` does in `sendEventReport_`:
 *
 *   - `410` permanently disposes the event target. Telemetry stops for the rest
 *     of the session. Nothing here returns it; if this endpoint is ever retired,
 *     that is the code to retire it with.
 *   - `429` and `5xx` THROW, and the caller re-queues the batch at the head of
 *     the queue. So answering a malformed body with a server error would make a
 *     body that can never succeed be resent forever -- a client-side queue that
 *     grows without bound because of a defect in the client's own encoder.
 *   - Every other status is treated as delivered and the batch is dropped.
 *
 * Hence the rule: a refusal this endpoint makes ABOUT THE REQUEST is always a
 * 4xx, so the client stops. The only 5xx this route can produce is the response
 * failing its own schema, which is a fault of ours and is the one case where a
 * retry is the right behaviour.
 *
 * `202` rather than `200` for the success: the report is accepted and converted
 * to structured records, and the body that comes back is a receipt rather than a
 * resource. Nothing is queried afterwards.
 */
export function cmcdCollectorHttpStatus(response: CmcdCollectorResponse): number {
  if (response.outcome === "collected") return 202;

  switch (response.reasons[0].code) {
    case "content_type_not_supported":
      return 415;
    case "body_too_large":
      return 413;
    default:
      /* Everything else is a body this endpoint understood well enough to know
       * it is not a report. 400 tells the client to stop resending it. */
      return 400;
  }
}
