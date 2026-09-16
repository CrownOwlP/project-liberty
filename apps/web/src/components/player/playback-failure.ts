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
 *
 * 3. CLASSIFICATION IS DERIVED PER ENGINE AND THE RESULT IS ENGINE-NEUTRAL
 *    (PL-0904). `PlaybackFailureKind` names four REMEDIES, and a remedy is a
 *    product fact rather than an engine fact: a stream that is gone is
 *    `source_unavailable` whether Shaka or mpv discovered it. So the vocabulary
 *    stays exactly as `@liberty/contracts` defines it and `@liberty/media-engine`
 *    consumes it, and what varies is the DERIVATION — one branch per engine,
 *    each reading only its own engine's numbering, dispatched by narrowing the
 *    `PlaybackError` union on `engine`.
 *
 *    That shape is what keeps `packages/media-engine` from learning about
 *    either engine. The alternative — an engine-qualified kind, or an engine
 *    field on `PlaybackAttemptFailure` — would put "which player was running"
 *    into the scheduler's decision, and the scheduler's whole premise is that it
 *    decides on a multiset of remedies and nothing else. The engine is visible
 *    in the reason trail, where a human debugging a session needs it; it is
 *    absent from the failover input, where it would only ever be a reason to
 *    retry one engine's failure and not the other's.
 * ---------------------------------------------------------------------- */

import type { PlaybackFailureKind } from "@liberty/contracts/domains/failover";
import type {
  NativeMpvPlaybackError,
  PlaybackError,
  PlaybackErrorDetail,
  WebShakaPlaybackError
} from "./shaka-error";

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
 * THE LITERAL IT USED TO GUARD IS GONE, and saying so is the honest version of
 * this note. `recordCandidateFailure` in `playback-machine.ts` used to fall back
 * to `"network_transient"` for a non-fatal error the classifier could not place;
 * that fallback was safe only while `network_transient` was exactly the retryable
 * set, and this list was the trip-wire for widening the engine's policy without
 * revisiting it. The fallback was removed — it was reachable on a RECOVERABLE
 * `BAD_HTTP_STATUS` carrying 451, where a guessed transient kind bought a rights
 * failure a second `load()` — so nothing in the player now depends on the
 * retryable set having exactly one member.
 *
 * The list is KEPT because what it asserts was never really about that literal:
 * `classifyHttpStatus` hands back `network_transient` for 408, 429 and 5xx and
 * NOTHING ELSE, and it does so because those are the statuses for which a second
 * request is worth an attempt. That reasoning is a claim about
 * `PLAYBACK_FAILURE_POLICY`'s retryable half, stated in this file, in a file that
 * does not import it. If the engine ever made a second kind retryable — or made
 * `network_transient` terminal — this classifier's status table would be deciding
 * retryability against a policy it no longer matched, and nothing else in the
 * player would notice. Deleting the list would delete the only place that
 * disagreement fails.
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

function classifyNetworkError(error: WebShakaPlaybackError): PlaybackFailureKind | null {
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
 * Shaka 5.2.x's category and code, and NOTHING ELSE'S.
 *
 * The parameter is `WebShakaPlaybackError` rather than `PlaybackError` on
 * purpose: handing this function a native error is a compile error, which is
 * the property PL-0903 asked for. Its body is unchanged from before PL-0904 —
 * every existing Shaka case means exactly what it meant, and the unmodified
 * regressions in `playback-failure.test.ts` and `shaka-error.test.ts` are the
 * proof.
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
function classifyShakaFailure(error: WebShakaPlaybackError): PlaybackFailureKind | null {
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
 * libmpv's END_FILE, and TODAY IT CLASSIFIES NOTHING. That is the answer, not a
 * stub.
 *
 * `_STOP` and `_REDIRECT` never arrive here — `error.aborted` took them one
 * branch up, which is why the guard below is about `_ERROR` and not about them.
 * What is left is `_ERROR` carrying an `mpv_error` value, and there is no
 * honest table from that value to one of the four remedies:
 *
 *   - `docs/DESKTOP_PLAYBACK.md` §5 records that PL-0901's research verified
 *     that `_ERROR` carries an `error` field and did NOT enumerate the
 *     `mpv_error` enum. A mapping written here would be written from memory.
 *   - Even fully enumerated it is coarser than Shaka's pairs: mpv collapses a
 *     network failure and a demuxer failure into one loading failure, and the
 *     two have opposite remedies.
 *
 * SO IT RETURNS `null`, AND THE SYSTEM IS ALREADY BUILT FOR THAT. Rule 1 above:
 * an unclassified error still ends the attempt, `countAttempt` in
 * `playback-machine.ts` has already charged it to the candidate, and
 * `@liberty/media-engine` rules the candidate out as
 * `attempt_failed_unclassified` — more attempts than named failures is exactly
 * the evidence the scheduler is built to read. Nothing silently resets the
 * budget and nothing is retried on a guess.
 *
 * AN INVENTED KIND HERE WOULD BE WORSE THAN THE `null`, and PL-0204's approval
 * turned on that. `network_transient` would buy a second `load()` for a failure
 * that will never succeed, including for a rights failure mpv reported as a
 * generic loading error; `decode_failed` would permanently discard a stream
 * that was briefly unreachable. This is the same defect the removed
 * `network_transient` fallback in `recordCandidateFailure` was, and it is not
 * being reintroduced through a different door.
 *
 * WHAT WOULD CHANGE THIS, precisely: the `mpv_error` enum read off
 * `include/mpv/client.h` at the pinned client API version, value by value, the
 * way `lib/util/error.js` was read for Shaka — a deliberate edit, with the
 * values written down here, by the task that writes the adapter. Or an
 * ENGINE-NEUTRAL `detail` the adapter can honestly fill in: `classifyHttpStatus`
 * above reads HTTP's scale, not Shaka's, so a native error carrying a real
 * `http-status` detail could be classified by it without either engine learning
 * about the other. That branch is deliberately NOT written yet, because mpv
 * surfaces no HTTP status today and the only way to fake one would be to parse
 * FFmpeg's English error text — which is the provider-free-text regex the
 * failover contract was written to forbid.
 */
function classifyNativeFailure(error: NativeMpvPlaybackError): PlaybackFailureKind | null {
  if (error.fault === null || error.fault.reason !== "error") return null;
  return null;
}

/**
 * The one place a `PlaybackError` becomes a contract failure kind.
 *
 * Dispatch is a narrow on `engine`, so each engine's numbering is read by
 * exactly one function and only ever in its own terms. The kind that comes back
 * is engine-neutral: `@liberty/media-engine` receives a remedy and never learns
 * which player produced it.
 */
export function classifyPlaybackFailure(error: PlaybackError): PlaybackFailureKind | null {
  /*
   * LOAD_INTERRUPTED and OPERATION_ABORTED describe OUR control flow — a second
   * `load()`, a teardown — and arrive with CRITICAL severity. mpv's END_FILE
   * `_STOP` and `_REDIRECT` are the same fact. Charging a candidate for one
   * would make every failover look like a fault caused by the candidate it
   * failed over TO. Checked before the dispatch because it is true on both
   * engines for the same reason.
   */
  if (error.aborted) return null;

  switch (error.engine) {
    case "web-shaka":
      return classifyShakaFailure(error);
    case "native-mpv":
      return classifyNativeFailure(error);
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
 *
 * IT TAKES A BARE NUMBER AND NOT A `PlaybackError`, so it is outside the
 * per-engine dispatch above and stays that way. The number space is the HTML
 * standard's, which belongs to neither engine — the same reason the
 * `media-element` variant of `PlaybackErrorDetail` sits beside the engine fault
 * rather than inside it. The web path is simply the only one that has a
 * `<video>` element to hear it from; if the native shell ever grows one, this
 * function is already the right shape for it.
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
