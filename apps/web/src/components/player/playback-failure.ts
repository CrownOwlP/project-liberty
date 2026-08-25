/* -------------------------------------------------------------------------
 * From "an error happened" to "which of the four remedies is this"
 *
 * `@liberty/contracts/domains/failover` is explicit that a failure is a CLOSED
 * VOCABULARY rather than an error object, and about why: if retryability were
 * decided by matching provider-authored free text, the rights boundary would be
 * enforced by a regular expression, and a provider rewording "entitlement
 * expired" to "access denied" would silently reclassify a rights failure as
 * something retryable. Classification is data the reporter must assert. This
 * file is where the player asserts it, once, from `shaka.util.Error`'s
 * already-normalised numeric category and code.
 *
 * TWO RULES GOVERN EVERYTHING BELOW.
 *
 * 1. `null` IS A LEGITIMATE ANSWER AND IT IS NOT A FAILURE TO ANSWER. The
 *    contract says a reporter that genuinely cannot tell must report nothing
 *    rather than guess, because an invented `network_transient` buys retries for
 *    something that will never succeed and an invented `decode_failed`
 *    permanently discards a stream that was briefly unreachable. An
 *    unclassified error still ends the attempt — the machine saw a critical
 *    error on that candidate — it simply does not earn a retry and does not
 *    enter `failures`, where it would be an unattributable claim.
 *
 * 2. WHEN IN DOUBT BETWEEN `rights_unverifiable` AND ANYTHING ELSE, CHOOSE
 *    `rights_unverifiable`. It is the only kind that is never retried at any
 *    budget, so choosing it can only ever cost us a stream we might have
 *    played. Choosing anything else can cost us a second attempt to play
 *    something we are not entitled to play, which product invariants 1 and 2
 *    forbid outright. The two are not symmetric and the tie is not a coin flip.
 *
 * Category and code numbers are pinned to shaka-player 5.2.x, the same pin
 * `shaka-error.ts` carries. They are read from the already-normalised
 * `PlaybackError`, so nothing here indexes Shaka's positional `data` array.
 * ---------------------------------------------------------------------- */

import type { PlaybackFailureKind } from "@liberty/contracts/domains/failover";
import type { PlaybackError, PlaybackErrorDetail } from "./shaka-error";

/* Pinned to shaka-player 5.2.x, `shaka.util.Error.Category`. */
const CATEGORY_NETWORK = 1;
const CATEGORY_MEDIA = 3;
const CATEGORY_MANIFEST = 4;
const CATEGORY_DRM = 6;

/* Pinned to shaka-player 5.2.x, `shaka.util.Error.Code`. */
const CODE_BAD_HTTP_STATUS = 1001;
const CODE_HTTP_ERROR = 1002;
const CODE_TIMEOUT = 1003;

/* `MediaError.code`, from the HTML standard. A different number space to Shaka's. */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * The kinds for which attempting the SAME candidate again is worth an attempt.
 *
 * NOTHING IN PRODUCTION CALLS EITHER OF THESE. The only importer is
 * `playback-failure.test.ts`. They are kept, on purpose, as a CONTRACT-DRIFT
 * ASSERTION rather than as a utility, and the honest reading of the export is
 * "this is a claim about `@liberty/media-engine`, pinned so that changing the
 * engine's answer fails a test here".
 *
 * The claim is load-bearing even with no caller, because a literal elsewhere in
 * the player depends on it. `recordCandidateFailure` in `playback-machine.ts`
 * falls back to `"network_transient"` for a non-fatal error the classifier
 * cannot place, and that fallback is only safe while `network_transient` is
 * exactly the retryable set — a kind recorded as transient goes into `failures`,
 * reaches `scheduleAttempts`, and buys the candidate another `load()`. Widening
 * `PLAYBACK_FAILURE_POLICY`'s retryable half without revisiting that fallback is
 * the mistake this list exists to catch, and with the list gone the mistake
 * would land silently.
 *
 * The earlier justification for restating the constant — that this module is
 * reached only from `shaka-error.ts` and the classifier, "none of which
 * otherwise depend on `@liberty/media-engine`" — no longer holds: the machine
 * imports `scheduleAttempts` from that package and runs it in the browser. What
 * survives of it is the narrower and still-true point that
 * `PLAYBACK_FAILURE_POLICY` is a whole table and a test file costs no bundle, so
 * the cross-check lives in the test and the constant stays two words.
 *
 * A COPY OF A CONSTANT, NEVER A COPY OF A POLICY, and the difference is the
 * whole lesson of the failover-scheduling defect. Two lists that a test proves
 * equal are one fact written twice; two SCHEDULERS that comments claim agree are
 * two facts, and they diverged. Anything with a decision in it goes back to the
 * engine — `playback-machine.ts` calls `scheduleAttempts` for exactly that
 * reason.
 */
export const RETRYABLE_FAILURE_KINDS: readonly PlaybackFailureKind[] = ["network_transient"];

export function isRetryableFailure(kind: PlaybackFailureKind | null): boolean {
  return kind !== null && RETRYABLE_FAILURE_KINDS.includes(kind);
}

function httpStatusOf(detail: PlaybackErrorDetail | null): number | null {
  /* Read through a local binding so the discriminant narrows: `detail` on the
   * error is a property access and this stays correct if it ever stops being
   * readonly. */
  return detail !== null && detail.kind === "http-status" ? detail.status : null;
}

/**
 * A network failure's remedy, decided by HTTP status where one is known.
 *
 * 401 and 403 are `rights_unverifiable` rather than "the CDN said no". On a
 * signed-URL delivery path they are what an expired or wrong signature looks
 * like, which IS authorization that could not be established or refreshed — and
 * by rule 2 above the ambiguity resolves that way regardless.
 *
 * 404 and 410 are `source_unavailable`: the asset is not there, which says
 * nothing about our rights or the device, and the remedy is the provider's.
 *
 * 408, 429 and 5xx are the only statuses that earn a retry. Everything else —
 * a 400 from a malformed request we built, a 451, a 3xx that reached us as an
 * error — returns `null`, because we would be guessing.
 */
function classifyHttpStatus(status: number): PlaybackFailureKind | null {
  if (status === 401 || status === 403) return "rights_unverifiable";
  if (status === 404 || status === 410) return "source_unavailable";
  if (status === 408 || status === 429 || status >= 500) return "network_transient";
  return null;
}

function classifyNetworkError(error: PlaybackError): PlaybackFailureKind | null {
  /*
   * A timeout and a transport-level failure are transient by definition: no
   * response arrived, so nothing was learned about the asset, the rights or the
   * device. Shaka has already exhausted its own request-level retries by the
   * time either of these surfaces as an error.
   */
  if (error.code === CODE_TIMEOUT || error.code === CODE_HTTP_ERROR) return "network_transient";
  if (error.code !== CODE_BAD_HTTP_STATUS) return null;

  const status = httpStatusOf(error.detail);
  return status === null ? null : classifyHttpStatus(status);
}

/**
 * The one place a `PlaybackError` becomes a contract failure kind.
 *
 * DRM is `rights_unverifiable` for every code in the category, including the
 * ones that wrap a network failure underneath. That is deliberate and it is
 * rule 2: a licence request that failed for a transient reason and one that
 * failed because the entitlement is gone are indistinguishable from outside the
 * licence server, and only one of the two possible mistakes is a rights
 * mistake. It also means a DRM candidate is never retried, which is the
 * behaviour invariants 1 and 2 want.
 *
 * MANIFEST is `source_unavailable` rather than `decode_failed`: a manifest that
 * will not parse has not disproven anything about the device, and the fix is the
 * publisher's. MEDIA is `decode_failed`, which settles the compatibility
 * question negatively and is therefore INFORMATION rather than noise.
 *
 * STREAMING (category 5), TEXT, PLAYER, CAST, STORAGE and ADS are absent on
 * purpose and fall through to `null`. Their codes mix decode failures,
 * transmux failures and control-flow errors in one category, so a
 * category-level answer for them would be a guess — and adding one means
 * reading `lib/util/error.js` for the pinned Shaka minor code by code, which is
 * a deliberate edit rather than a default.
 */
export function classifyPlaybackFailure(error: PlaybackError): PlaybackFailureKind | null {
  /*
   * LOAD_INTERRUPTED and OPERATION_ABORTED describe OUR control flow — a second
   * `load()`, a teardown — and arrive with CRITICAL severity. Charging a
   * candidate for one would make every failover look like a fault caused by the
   * candidate it failed over TO.
   */
  if (error.aborted) return null;

  switch (error.category) {
    case CATEGORY_DRM:
      return "rights_unverifiable";
    case CATEGORY_MEDIA:
      return "decode_failed";
    case CATEGORY_MANIFEST:
      return "source_unavailable";
    case CATEGORY_NETWORK:
      return classifyNetworkError(error);
    default:
      return null;
  }
}

/**
 * The `<video>` element's own `MediaError`, which is a different number space
 * to Shaka's and reaches us on a different route.
 *
 * `MEDIA_ERR_ABORTED` returns `null` for the same reason `error.aborted` does:
 * it means the load was abandoned, which is our own control flow. Shaka
 * normally re-reports these as its own category-3 errors, but not always — a
 * decode failure that kills the element while Shaka is mid-teardown arrives
 * only here, and an unwired `error` listener loses it silently.
 */
export function classifyMediaElementError(mediaErrorCode: number | null): PlaybackFailureKind | null {
  switch (mediaErrorCode) {
    case MEDIA_ERR_NETWORK:
      return "network_transient";
    case MEDIA_ERR_DECODE:
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "decode_failed";
    case MEDIA_ERR_ABORTED:
    default:
      return null;
  }
}

export function isAbortedMediaElementError(mediaErrorCode: number | null): boolean {
  return mediaErrorCode === MEDIA_ERR_ABORTED;
}
