import { readFile } from "node:fs/promises";

import { NO_MEDIA_PREFERENCES } from "@liberty/contracts/domains/preferences";
import { describe, expect, it } from "vitest";

import {
  CMCD_COLLECTOR_PATH,
  PLAYBACK_TELEMETRY_DEFAULTS,
  decidePlaybackTelemetry
} from "./telemetry-decision";

/* -------------------------------------------------------------------------
 * The diagnostics control, and the claim it has to earn (PL-0724)
 *
 * ==========================================================================
 * WHAT THIS ENVIRONMENT CAN AND CANNOT SEE
 * ==========================================================================
 *
 * `apps/web/vitest.config.ts` sets `environment: "node"`: no DOM, no
 * `customElements`, no effect ever runs. `PlayerSurface` cannot be rendered
 * here and is not rendered here. Pretending otherwise would mean a mock of
 * the media engine, and a test that proves a mock does not send CMCD is a
 * test about the mock.
 *
 * So this file asserts the two halves that ARE decidable without a browser,
 * and the acceptance's claim is the conjunction of exactly those two:
 *
 *   1. the DECISION the component feeds: `decidePlaybackTelemetry` with
 *      `enabled: false` must produce a config that actually switches CMCD
 *      off, and must do so without letting a viewer's "yes" override any
 *      safety refusal;
 *   2. that the component feeds it the VIEWER'S ANSWER rather than a
 *      literal, which is a source rule because the wiring is one expression
 *      inside an effect this environment cannot run.
 *
 * The third half -- that the engine honours the config it is handed -- is
 * `@liberty/media-engine`'s and is covered by its own suite and by the
 * player e2e. This file does not claim it.
 * ---------------------------------------------------------------------- */

/**
 * What the engine config says about CMCD, read the way the module reads it.
 *
 * `EngineConfig` indexes to `unknown` -- it is a fragment merged into an
 * engine's configuration history, not a typed options object -- so
 * `config.cmcd?.enabled` does not compile. `telemetry-decision.ts` has its own
 * `isCmcdEnabled` doing exactly this defensively, and this mirrors it rather
 * than casting, so the assertions below are about the value that actually
 * reaches the engine.
 *
 * Returns `undefined` when there is no block at all, which is a THIRD state
 * and the one that matters most here: an absent block leaves a previously
 * configured value in force, so "off" and "unspecified" must never be
 * conflated by this helper.
 */
function cmcdEnabled(config: unknown): boolean | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const block: unknown = (config as Record<string, unknown>)["cmcd"];
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  const value: unknown = (block as Record<string, unknown>)["enabled"];
  return typeof value === "boolean" ? value : undefined;
}

/** The inputs the component passes, with only `enabled` varying. */
function decisionFor(enabled: boolean, over: Record<string, unknown> = {}) {
  return decidePlaybackTelemetry({
    enabled,
    contentId: "aurora-fall",
    sessionId: "01J0000000000000000000000A",
    collectorPath: CMCD_COLLECTOR_PATH,
    ...PLAYBACK_TELEMETRY_DEFAULTS,
    ...over
  });
}

describe("a viewer who declines actually stops diagnostics being sent", () => {
  it("would have sent them, so the decline is what makes the difference", () => {
    /*
     * THE CONTROL CASE, AND WITHOUT IT THE NEXT ONE PROVES NOTHING. If these
     * inputs were refused for some other reason -- an untransmittable id, a
     * collector path that is not first-party -- then "declining switches it
     * off" would be true of a configuration that was already off, and the
     * test would pass while the control did nothing.
     */
    const allowed = decisionFor(true);
    expect(allowed.enabled).toBe(true);
    expect(cmcdEnabled(allowed.config)).toBe(true);
  });

  it("switches CMCD off as a stated instruction, not by omission", () => {
    /*
     * `{ cmcd: { enabled: false } }` AND NOT AN ABSENT BLOCK. The controller
     * replays its configuration history onto every player it builds, so a
     * decision that merely said nothing about CMCD would leave a previously
     * configured value in force -- and a viewer who declined mid-session, or
     * whose player was rebuilt by a failover, would keep reporting. The
     * difference between `undefined` and `false` here is the difference
     * between a setting and a suggestion.
     */
    const declined = decisionFor(false);
    expect(declined.enabled).toBe(false);
    expect(cmcdEnabled(declined.config), "no cmcd block at all leaves a previous value in force").toBeDefined();
    expect(cmcdEnabled(declined.config)).toBe(false);
  });

  it("says it was the viewer, not a failure", () => {
    /*
     * The reason code matters because this screen shows it. A decline
     * reported as a fault would send somebody to fix a collector that is
     * working.
     */
    const declined = decisionFor(false);
    expect(declined.reasons.map((reason) => reason.code)).toContain("telemetry_disabled");
  });
});

describe("a viewer may decline, and may not override a refusal", () => {
  /*
   * THE ACCEPTANCE CALLS THIS OUT BY NAME -- "'the toggle wins' is the obvious
   * implementation and it is the wrong one" -- so each safety refusal is
   * driven with the viewer ALLOWING diagnostics, which is the only setting
   * under which an override could happen at all.
   */
  const refusals: readonly { readonly why: string; readonly input: Record<string, unknown> }[] = [
    { why: "no session id could be minted", input: { sessionId: null } },
    { why: "the session id is not transmittable", input: { sessionId: "https://evil.test/x" } },
    { why: "the content id is not transmittable", input: { contentId: "https://evil.test/x.mpd" } },
    { why: "the collector is not first-party", input: { collectorPath: "https://evil.test/c" } }
  ];

  for (const { why, input } of refusals) {
    it(`still refuses when ${why}, even though the viewer allowed it`, () => {
      const decision = decisionFor(true, input);
      expect(decision.enabled, why).toBe(false);
      expect(cmcdEnabled(decision.config), why).toBe(false);
      /* And it does NOT report the viewer's opt-out as the reason, because
       * the viewer did not opt out. */
      expect(decision.reasons.map((r) => r.code), why).not.toContain("telemetry_disabled");
    });
  }

  it("NOT ASSERTED HERE: the empty-allowlist refusal, and why", () => {
    /*
     * `client_key_allowlist_empty` is the fifth refusal and this file does
     * NOT drive it. A first draft tried, by passing `clientKeys: []`, and it
     * failed with the decision still enabled -- because there is no such
     * input. `PlaybackTelemetryInput` carries enabled, contentId, sessionId,
     * collectorPath, batchSize and intervalSeconds; the allowlist is
     * internal to `playbackTelemetryConfig` and is not reachable by varying
     * what a caller passes.
     *
     * The draft is recorded rather than deleted because the failure is
     * instructive: zod-less input objects accept unknown keys silently, so a
     * test that invents an option name asserts nothing and SAYS it asserted
     * something. Had the expectation been `toBe(true)` it would have passed
     * and I would have believed the allowlist was covered from here.
     *
     * What IS asserted is that the viewer's allow does not reach past the
     * four refusals that are input-reachable, which is the property the
     * acceptance names. `client_key_allowlist_empty` is not currently
     * asserted anywhere -- `telemetry-decision.test.ts` does not name it
     * either -- and that gap is stated rather than papered over. It belongs
     * to telemetry-decision.ts's own suite, which can reach the allowlist,
     * and not to a task whose surface is this control.
     */
    expect(decisionFor(true).reasons.map((r) => r.code)).not.toContain(
      "client_key_allowlist_empty"
    );
  });
});

describe("the component feeds it the viewer's answer, not a literal", () => {
  async function source(): Promise<string> {
    const raw = await readFile(new URL("./player-surface.tsx", import.meta.url), "utf8");
    /* Comments stripped first: this component's header discusses the literal
     * it replaced, in those words, and a rule its own explanation can fail is
     * not a rule. The pattern `degraded-banner.test.tsx` established. */
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("passes the prop where `enabled: true` used to be", async () => {
    const text = await source();
    expect(text).toMatch(/enabled:\s*diagnosticsAllowed/);
  });

  it("contains no `enabled: true` anywhere, which is what regressed", async () => {
    /*
     * THE RULE THAT MATTERS. The prop could be added, wired, and then a later
     * edit could reintroduce the literal somewhere else in this file and
     * every other assertion here would still pass. This is the one that
     * notices.
     */
    const text = await source();
    expect(text).not.toMatch(/enabled:\s*true/);
    /* Non-vacuity: the file really does configure telemetry. */
    expect(text).toMatch(/decidePlaybackTelemetry\(/);
  });

  it("defaults to the same value an unconfigured profile carries", async () => {
    /*
     * TWO DEFAULTS THAT MUST NOT DRIFT. The component defaults the prop so
     * existing callers keep compiling and get yesterday's behaviour;
     * `NO_MEDIA_PREFERENCES` defaults the stored field for a profile that
     * has chosen nothing. If those two ever disagreed, whether a viewer got
     * diagnostics would depend on which code path reached them, which is the
     * kind of difference nobody finds by reading.
     */
    const text = await source();
    expect(text).toMatch(/diagnosticsAllowed\s*=\s*true/);
    expect(NO_MEDIA_PREFERENCES.playbackDiagnostics).toBe(true);
  });

  it("does not fetch the answer itself", async () => {
    /*
     * It is handed down from the server, like `nextUp`. A client component
     * that fetched a preference during player start would be making a
     * network call on the path to first frame, for a setting -- and the
     * acceptance's "do not fake persistence with local component state" has
     * a sibling failure mode where the state is real but arrives too late to
     * configure the engine it was supposed to configure.
     */
    const text = await source();
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
