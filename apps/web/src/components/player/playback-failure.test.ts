import { PLAYBACK_FAILURE_KINDS } from "@liberty/contracts/domains/failover";
import { PLAYBACK_FAILURE_POLICY } from "@liberty/media-engine";
import { describe, expect, it } from "vitest";
import {
  RETRYABLE_FAILURE_KINDS,
  classifyMediaElementError,
  classifyPlaybackFailure,
  isAbortedMediaElementError,
  isRetryableFailure
} from "./playback-failure";
import { describePlaybackError } from "./shaka-error";

/*
 * `PLAYBACK_FAILURE_POLICY` is imported HERE and not by `playback-failure.ts`. A
 * test file costs no bundle, so the retryability rule can be cross-checked
 * against its authority without the table riding into the browser for one
 * boolean, and `RETRYABLE_FAILURE_KINDS` stays a two-word constant whose drift
 * from the authority is a failing test rather than a divergence nobody notices.
 *
 * That is a statement about THIS module, not about the player as a whole:
 * `playback-machine.ts` calls `scheduleAttempts` from the same package at
 * runtime, deliberately, because the alternative was a second copy of the
 * failover scheduling policy that disagreed with the first.
 */

function classify(init: { severity: number; category: number; code: number; data?: readonly unknown[] }) {
  return classifyPlaybackFailure(
    describePlaybackError(
      { severity: init.severity, category: init.category, code: init.code, data: init.data ?? [], handled: false },
      "player-event"
    )
  );
}

/** `data[0]` is the URL and `data[1]` the status for BAD_HTTP_STATUS in 5.2.x. */
function httpStatus(status: number) {
  return classify({
    severity: 2,
    category: 1,
    code: 1001,
    data: ["https://cdn.example.com/seg.m4s?sig=redacted", status]
  });
}

describe("agreement with the contract's own policy", () => {
  it("calls exactly the kinds retryable that PLAYBACK_FAILURE_POLICY does", () => {
    /*
     * The whole reason `RETRYABLE_FAILURE_KINDS` is restated in the player is
     * bundle size, and the whole risk of restating it is drift. This turns that
     * risk into a failing test: widening the engine's policy without widening
     * the player's, or the reverse, fails here rather than producing a client
     * that retries something the server considers settled.
     */
    const authoritative = PLAYBACK_FAILURE_KINDS.filter((kind) => PLAYBACK_FAILURE_POLICY[kind].retryable);
    expect([...RETRYABLE_FAILURE_KINDS].sort()).toEqual([...authoritative].sort());
  });

  it("agrees kind by kind, including on the ones that are never retried", () => {
    for (const kind of PLAYBACK_FAILURE_KINDS) {
      expect(isRetryableFailure(kind), kind).toBe(PLAYBACK_FAILURE_POLICY[kind].retryable);
    }
    expect(isRetryableFailure(null)).toBe(false);
  });
});

describe("classification", () => {
  it("treats every DRM failure as rights that could not be established", () => {
    /* Conservative on purpose, and asymmetric on purpose: choosing this costs a
     * stream we might have played, and choosing anything else costs a second
     * attempt to play something we may not be entitled to. Invariants 1 and 2. */
    expect(classify({ severity: 2, category: 6, code: 6007 })).toBe("rights_unverifiable");
    expect(classify({ severity: 2, category: 6, code: 6001 })).toBe("rights_unverifiable");
  });

  it("separates a decode failure from a missing asset", () => {
    /* Different remedies: one is the device capability model's problem and the
     * other is the provider's. A single "it broke" sends a reader to neither. */
    expect(classify({ severity: 2, category: 3, code: 3016 })).toBe("decode_failed");
    expect(classify({ severity: 2, category: 4, code: 4001 })).toBe("source_unavailable");
  });

  it("reads the HTTP status rather than the category for a network failure", () => {
    expect(httpStatus(401)).toBe("rights_unverifiable");
    expect(httpStatus(403)).toBe("rights_unverifiable");
    expect(httpStatus(404)).toBe("source_unavailable");
    expect(httpStatus(410)).toBe("source_unavailable");
    expect(httpStatus(408)).toBe("network_transient");
    expect(httpStatus(429)).toBe("network_transient");
    expect(httpStatus(503)).toBe("network_transient");
  });

  it("refuses to guess at a status it has no rule for", () => {
    /* The contract says a reporter that cannot tell must report nothing. An
     * invented `network_transient` buys retries for something that will never
     * succeed. */
    expect(httpStatus(400)).toBeNull();
    expect(httpStatus(451)).toBeNull();
    expect(classify({ severity: 2, category: 1, code: 1001 })).toBeNull();
  });

  it("treats a timeout and a transport failure as transient", () => {
    expect(classify({ severity: 2, category: 1, code: 1003 })).toBe("network_transient");
    expect(classify({ severity: 2, category: 1, code: 1002 })).toBe("network_transient");
  });

  it("never classifies an error that describes our own control flow", () => {
    /* LOAD_INTERRUPTED and OPERATION_ABORTED are CRITICAL and are ours. */
    expect(classify({ severity: 2, category: 7, code: 7000 })).toBeNull();
    expect(classify({ severity: 2, category: 7, code: 7001 })).toBeNull();
  });

  it("returns null for the categories whose codes have not been read one by one", () => {
    /* STREAMING mixes decode, transmux and control-flow failures in one
     * category, so a category-level answer for it would be a guess. Adding one
     * is a deliberate edit against the pinned Shaka minor, not a default. */
    expect(classify({ severity: 2, category: 5, code: 5006 })).toBeNull();
    expect(classify({ severity: 2, category: 2, code: 2001 })).toBeNull();
  });

  it("classifies the media element's own error codes, which are a different number space", () => {
    expect(classifyMediaElementError(2)).toBe("network_transient");
    expect(classifyMediaElementError(3)).toBe("decode_failed");
    expect(classifyMediaElementError(4)).toBe("decode_failed");
    expect(classifyMediaElementError(1)).toBeNull();
    expect(classifyMediaElementError(null)).toBeNull();

    expect(isAbortedMediaElementError(1)).toBe(true);
    expect(isAbortedMediaElementError(3)).toBe(false);
    expect(isAbortedMediaElementError(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * PL-0904 — classification derived per engine, neutral on the way out
 *
 * Everything above this line predates PL-0904 and is UNCHANGED. That is the
 * evidence that every existing Shaka case still means what it meant: the Shaka
 * branch is the same function body reached through a narrow, and the whole
 * table above still passes without an edit.
 * ---------------------------------------------------------------------- */

import { describeNativePlaybackError } from "./shaka-error";

function classifyNative(reason: "error" | "stop" | "redirect", mpvError?: number) {
  return classifyPlaybackFailure(
    describeNativePlaybackError(
      mpvError === undefined ? { reason } : { reason, mpvError },
      "player-event"
    )
  );
}

describe("a native failure is never read on Shaka's scale", () => {
  it("refuses to classify an mpv error value, including ones that collide with Shaka's", () => {
    /*
     * 6, 3 and 4 are DRM, MEDIA and MANIFEST on shaka-player 5.2.x, and the
     * Shaka branch turns each of them into a kind. Read on mpv's scale they
     * mean nothing of the sort. If the dispatch ever sent a native error to the
     * Shaka classifier — or if an mpv number reached `category` — these three
     * would come back `rights_unverifiable`, `decode_failed` and
     * `source_unavailable`, and a stream we are not entitled to play would be
     * retried or a briefly-unreachable one permanently discarded.
     */
    expect(classifyNative("error", 6)).toBeNull();
    expect(classifyNative("error", 3)).toBeNull();
    expect(classifyNative("error", 4)).toBeNull();
    // And the values mpv actually reports, which are negative.
    expect(classifyNative("error", -13)).toBeNull();
    expect(classifyNative("error", -17)).toBeNull();
  });

  it("stays unclassified when there is no mpv error value either", () => {
    /*
     * This is the honest outcome, not a gap. The attempt is still charged by
     * `countAttempt`, the candidate is still marked tried, and
     * `@liberty/media-engine` rules it out as `attempt_failed_unclassified`
     * because it sees more attempts than named failures. Manufacturing a kind
     * to avoid this branch is what PL-0204's approval turned on NOT doing.
     */
    expect(classifyNative("error")).toBeNull();
  });

  it("never classifies mpv END_FILE reasons that describe our own control flow", () => {
    expect(classifyNative("stop", -13)).toBeNull();
    expect(classifyNative("redirect")).toBeNull();
  });

  it("classifies the media element's codes without reference to either engine", () => {
    // `classifyMediaElementError` is outside the per-engine dispatch on purpose:
    // `MediaError.code` is the HTML standard's number space, belonging to
    // neither engine, and the assertions above in this file still hold.
    expect(classifyMediaElementError(3)).toBe("decode_failed");
  });
});

describe("the kind that reaches the media engine is engine-neutral", () => {
  it("returns only kinds the contract defines, from either engine", () => {
    /*
     * The failover scheduler decides on a multiset of REMEDIES. If PL-0904 had
     * qualified the kind by engine — `decode_failed_mpv`, or a kind plus an
     * engine field — `packages/media-engine` would have had to learn which
     * players exist in order to decide anything. It does not, and this asserts
     * the surface that keeps it that way: whatever the engine, the output is
     * either one of the contract's four kinds or `null`.
     */
    const outcomes = [
      classify({ severity: 2, category: 6, code: 6007 }),
      classify({ severity: 2, category: 3, code: 3016 }),
      classify({ severity: 2, category: 4, code: 4001 }),
      httpStatus(503),
      classifyNative("error", -13),
      classifyNative("stop")
    ];

    for (const outcome of outcomes) {
      expect(outcome === null || PLAYBACK_FAILURE_KINDS.includes(outcome)).toBe(true);
    }
    // Both engines are represented, and both engine-neutral answers appear.
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(2);
  });
});
