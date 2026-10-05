import { afterEach, describe, expect, it, vi } from "vitest";
import { CMCD_DISABLED, isFirstPartyCollectorPath } from "./telemetry";
import {
  CMCD_COLLECTOR_PATH,
  PLAYBACK_TELEMETRY_DEFAULTS,
  decidePlaybackTelemetry,
  mintTelemetrySessionId,
  type PlaybackTelemetryInput,
  type PlaybackTelemetryReasonCode
} from "./telemetry-decision";

/* -------------------------------------------------------------------------
 * The decision, under test.
 *
 * `telemetry.test.ts` already pins what the configuration seam PRODUCES: that
 * no URL-bearing key is ever requested, that an empty allowlist fails closed,
 * that the identifiers are validated. What is pinned here is the thing that
 * file deliberately does not have -- WHICH refusal happened -- because
 * `playbackTelemetryConfig` answers every one of them with the identical
 * disabled block, and an operator cannot tell a deliberate opt-out from a
 * misconfiguration by looking at it.
 * ---------------------------------------------------------------------- */

/** A real `crypto.randomUUID()` shape, which is what a session id is. */
const SESSION_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/** A lowercase-kebab slug, which is what `normalizedContentIdSchema` permits. */
const CONTENT_ID = "the-northstar-affair";

const INPUT: PlaybackTelemetryInput = {
  enabled: true,
  contentId: CONTENT_ID,
  sessionId: SESSION_ID,
  collectorPath: CMCD_COLLECTOR_PATH,
  ...PLAYBACK_TELEMETRY_DEFAULTS
};

function decide(overrides: Partial<PlaybackTelemetryInput> = {}) {
  return decidePlaybackTelemetry({ ...INPUT, ...overrides });
}

function codeOf(overrides: Partial<PlaybackTelemetryInput>): PlaybackTelemetryReasonCode {
  return decide(overrides).reasons[0].code;
}

describe("the enabled decision", () => {
  it("turns CMCD on and says so", () => {
    const decision = decide();

    expect(decision.enabled).toBe(true);
    expect(decision.reasons[0].code).toBe("cmcd_configured");
    expect(decision.config).not.toEqual(CMCD_DISABLED);
  });

  it("publishes the identifiers only once both have been validated", () => {
    // This is the only place in the player that has decided `cid` and `sid` are
    // safe to send. PL-0504's emitter takes them from here rather than from the
    // props, so there is no second, unguarded path for an identifier to leave.
    expect(decide().identifiers).toEqual({ contentId: CONTENT_ID, sessionId: SESSION_ID });
    expect(decide({ sessionId: null }).identifiers).toBeNull();
    expect(decide({ contentId: "https://cdn.example.com/x.m3u8" }).identifiers).toBeNull();
  });

  it("points at a path that can only resolve to our own origin", () => {
    expect(isFirstPartyCollectorPath(CMCD_COLLECTOR_PATH)).toBe(true);
  });
});

describe("every refusal names itself", () => {
  it("distinguishes the five ways telemetry ends up off", () => {
    expect(codeOf({ enabled: false })).toBe("telemetry_disabled");
    expect(codeOf({ sessionId: null })).toBe("session_id_unavailable");
    expect(codeOf({ sessionId: "x".repeat(65) })).toBe("session_id_not_transmittable");
    expect(codeOf({ contentId: "https://cdn.example.com/northstar.m3u8?Signature=SECRET" })).toBe(
      "content_id_not_transmittable"
    );
    expect(codeOf({ collectorPath: "https://collector.example.com/cmcd" })).toBe(
      "collector_path_not_first_party"
    );
  });

  it("applies a stated `enabled: false` rather than an absent block", () => {
    // `PlaybackController` replays its configuration history onto every player,
    // so an absent `cmcd` block leaves a previous value in force. Only a stated
    // false actually turns CMCD off.
    for (const overrides of [
      { enabled: false },
      { sessionId: null },
      { contentId: "" },
      { collectorPath: "//evil.example.com/cmcd" }
    ] satisfies Partial<PlaybackTelemetryInput>[]) {
      const decision = decide(overrides);
      expect(decision.enabled, JSON.stringify(overrides)).toBe(false);
      expect(decision.config, JSON.stringify(overrides)).toEqual(CMCD_DISABLED);
    }
  });

  it("never returns an empty reason trail, on any branch", () => {
    for (const overrides of [
      {},
      { enabled: false },
      { sessionId: null },
      { sessionId: "" },
      { contentId: "" },
      { contentId: "northstar/1080p.m3u8" },
      { collectorPath: "" },
      { collectorPath: "/\\evil.example.com" }
    ] satisfies Partial<PlaybackTelemetryInput>[]) {
      const decision = decide(overrides);
      expect(decision.reasons.length, JSON.stringify(overrides)).toBeGreaterThan(0);
      expect(decision.reasons[0].detail.length, JSON.stringify(overrides)).toBeGreaterThan(0);
    }
  });

  it("does not leak the value it refused into the reason it gives", () => {
    // A content id that is a signed URL is refused; the refusal says which
    // check failed and does not quote the URL back into a panel or a log.
    const signed = "https://cdn.example.com/northstar/1080p.m3u8?Signature=SECRET-SIGNATURE";
    expect(JSON.stringify(decide({ contentId: signed }))).not.toContain("SECRET-SIGNATURE");
  });
});

describe("a telemetry misconfiguration cannot take playback down", () => {
  it("returns a decision rather than throwing, for every input", () => {
    for (const overrides of [
      { contentId: "" },
      { sessionId: null },
      { collectorPath: "https://evil.example.com" },
      { batchSize: Number.NaN },
      { intervalSeconds: -1 }
    ] satisfies Partial<PlaybackTelemetryInput>[]) {
      expect(() => decide(overrides), JSON.stringify(overrides)).not.toThrow();
    }
  });
});

describe("minting a session id", () => {
  it("uses the supplied source", () => {
    expect(mintTelemetrySessionId({ randomUUID: () => SESSION_ID })).toBe(SESSION_ID);
  });

  it("returns null rather than inventing one, for every unusable source", () => {
    /*
     * `crypto.randomUUID` exists only in a secure context, so a page served over
     * plain HTTP to something that is not localhost genuinely has no source of
     * one. Every alternative is worse: `Math.random` is not a fleet-unique
     * correlation id, and an empty string is what shaka-player reads as an
     * instruction to invent one -- which produces an id no server-side log can
     * be joined against.
     */
    expect(mintTelemetrySessionId(undefined)).toBeNull();
    expect(mintTelemetrySessionId(null)).toBeNull();
    expect(mintTelemetrySessionId({})).toBeNull();
    expect(mintTelemetrySessionId({ randomUUID: "not a function" })).toBeNull();
    expect(mintTelemetrySessionId({ randomUUID: () => "" })).toBeNull();
    expect(mintTelemetrySessionId({ randomUUID: () => 42 })).toBeNull();
    expect(
      mintTelemetrySessionId({
        randomUUID: () => {
          throw new Error("no entropy available");
        }
      })
    ).toBeNull();
  });

  it("calls the method on its own receiver", () => {
    // `crypto.randomUUID` is a method, and detaching it from its receiver is
    // not portable across engines.
    const source = {
      id: SESSION_ID,
      randomUUID(this: { id: string }): string {
        return this.id;
      }
    };
    expect(mintTelemetrySessionId(source)).toBe(SESSION_ID);
  });
});

describe("the fifth refusal, which nothing reached until now (PL-0731)", () => {
  /* ------------------------------------------------------------------------
   * WHY THIS NEEDED ITS OWN TASK, AND ITS OWN TECHNIQUE
   * ------------------------------------------------------------------------
   *
   * `client_key_allowlist_empty` is the one refusal `decidePlaybackTelemetry`
   * can return that NO INPUT PRODUCES. The other five are decided from
   * `PlaybackTelemetryInput` -- enabled, contentId, sessionId, collectorPath --
   * and the suite above drives each by varying one of them. This one is
   * decided by `CMCD_V2_CLIENT_SAFE_KEYS`, which `@liberty/observability`
   * COMPUTES at module load from the v2 key registry, and which no caller
   * passes in.
   *
   * A round-111 draft tried to reach it by passing `clientKeys: []` to the
   * decision. There is no such option: the object accepted the unknown key in
   * silence and the decision stayed enabled. That draft is recorded in
   * `player-surface.test.tsx` rather than deleted, because had its expectation
   * been inverted it would have PASSED while asserting nothing at all.
   *
   * SO THE SEAM IS THE MODULE, NOT THE ARGUMENT. The allowlist arrives by
   * import, so the import is where it is replaced -- the real
   * `decidePlaybackTelemetry`, the real `playbackTelemetryConfig`, the real
   * guards, with one derived constant substituted. Nothing in production
   * changed to make this reachable, which is the condition the task set: if
   * reaching it had required widening an input "for the test", the honest
   * answer was to report the branch as unreachable and stop.
   *
   * WHAT IT IS GUARDING. shaka-player's `CmcdManager` substitutes
   * `allKeysForVersion_(2)` for an EMPTY `includeKeys`, and that expansion
   * contains `url` and `nor`. So an allowlist that derived down to nothing
   * would not send nothing -- it would send everything, including the keys
   * that carry the media address. The refusal is the fail-closed on that, and
   * until this test nothing anywhere exercised it: `telemetry.test.ts` asserts
   * the allowlist is NON-empty, which is the opposite case.
   * --------------------------------------------------------------------- */

  afterEach(() => {
    /* The mock is per-test and must not leak into the file's other cases,
     * which assert against the REAL allowlist two describes above. */
    vi.doUnmock("@liberty/observability");
    vi.resetModules();
  });

  /** A fresh module graph, optionally with the derived allowlist emptied. */
  async function decideWith(keys: readonly string[]) {
    vi.resetModules();
    vi.doMock("@liberty/observability", async () => {
      const actual =
        await vi.importActual<typeof import("@liberty/observability")>("@liberty/observability");
      return { ...actual, CMCD_V2_CLIENT_SAFE_KEYS: keys };
    });
    /* NOT NAMED `module`. ESLint's `@next/next/no-assign-module-variable`
     * refuses that identifier, and CI #183 is where I found out: this file's
     * lint was never re-run after it was written, so a one-word local
     * decision became the first failing step of a job that had just been
     * taught to finish. */
    const reimported = await import("./telemetry-decision");
    return reimported.decidePlaybackTelemetry({
      enabled: true,
      contentId: CONTENT_ID,
      sessionId: SESSION_ID,
      collectorPath: reimported.CMCD_COLLECTOR_PATH,
      ...reimported.PLAYBACK_TELEMETRY_DEFAULTS
    });
  }

  it("CONTROL: the identical inputs decide ENABLED when the allowlist has keys", async () => {
    /*
     * WITHOUT THIS THE NEXT CASE PROVES NOTHING. Re-importing through a mocked
     * module graph could fail for reasons that have nothing to do with the
     * allowlist -- a guard rejecting these identifiers, the collector path
     * resolving differently -- and "it refused" would then be true of a
     * configuration that was already refusing. This drives the SAME path with
     * a NON-EMPTY allowlist and requires it to reach enabled.
     */
    const decision = await decideWith(["br", "bl", "d", "ot", "sid", "cid"]);

    expect(decision.enabled).toBe(true);
    expect(decision.reasons[0].code).toBe("cmcd_configured");
  });

  it("refuses with `client_key_allowlist_empty` when the allowlist derives to nothing", async () => {
    const decision = await decideWith([]);

    expect(decision.enabled).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("client_key_allowlist_empty");
  });

  it("and it is the ALLOWLIST that caused it, not the viewer and not an identifier", async () => {
    /*
     * The reason code is what an operator reads. A fail-closed reported as
     * `telemetry_disabled` would send somebody to look at a viewer's setting,
     * and one reported as an identifier problem would send them to the catalog
     * -- when the thing that is wrong is the key registry in
     * `@liberty/observability`.
     */
    const decision = await decideWith([]);
    /*
     * NON-VACUITY, AND IT WAS MISSING. A first version of this case asserted
     * only the ABSENCES below, and a mutation probe caught it: with the
     * fail-closed removed from `playbackTelemetryConfig` the decision came
     * back ENABLED, carrying `cmcd_configured` -- and every "not.toContain"
     * here was still satisfied, so the case stayed green while the refusal it
     * describes had stopped happening. An assertion that only names what must
     * be absent passes hardest when nothing is there at all.
     */
    expect(decision.enabled).toBe(false);
    expect(decision.reasons.map((reason) => reason.code)).toContain("client_key_allowlist_empty");

    const codes = decision.reasons.map((reason) => reason.code);

    expect(codes).not.toContain("telemetry_disabled");
    expect(codes).not.toContain("session_id_unavailable");
    expect(codes).not.toContain("session_id_not_transmittable");
    expect(codes).not.toContain("content_id_not_transmittable");
    expect(codes).not.toContain("collector_path_not_first_party");
  });

  it("applies a stated `enabled: false`, like the other four refusals", async () => {
    /*
     * The same property the case above asserts for the input-reachable
     * refusals, and it matters most here: `PlaybackController` replays its
     * configuration history onto every player it builds, so a decision that
     * merely said nothing about CMCD would leave a previously configured value
     * in force. A player rebuilt by a failover, on a deployment whose key
     * registry had derived down to nothing, would then keep reporting -- with
     * every v2 key, because that is what Shaka substitutes for an empty list.
     * The difference between `undefined` and `false` is the whole refusal.
     */
    const decision = await decideWith([]);

    expect(decision.config).toEqual(CMCD_DISABLED);
    expect(CMCD_DISABLED).toEqual({ cmcd: { enabled: false } });
  });
});
