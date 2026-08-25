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
