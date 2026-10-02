import { playbackSessionReasonCodeSchema } from "../app/api/v1/playback/session/contract";
import { describe, expect, it } from "vitest";

import {
  LIVENESS_CONFIRMATION_DELAYS_MS,
  MAX_LIVENESS_ATTEMPTS,
  SERVICE_UNAVAILABLE_CODES,
  classifyObservation,
  confirmationDelay,
  describeDegradation,
  isServiceUnavailableCode,
  nextReachability,
  unavailableReasonCode,
  type Reachability
} from "./network-state";

/* -------------------------------------------------------------------------
 * What is unreachable, and whose problem it is (PW-0309)
 *
 * THE CLAUSE THIS SUITE IS ORGANISED AROUND: "the sidecar being down is a
 * DISTINCT state from the backend being down and from the network being down,
 * because the three have different remedies and collapsing them produces a
 * support burden." Every collapse is therefore tested as a NEGATIVE as well as
 * the correct answer as a positive -- it is not enough that offline produces
 * "offline"; it has to be shown that a dead sidecar does not.
 *
 * The module is pure on purpose, so all of this runs in the `node` environment
 * this workspace uses. What it cannot reach -- a real lost connection, a real
 * `online` event, the banner on screen -- is `e2e/tests/degraded-states.spec.ts`,
 * which takes a real browser offline with `context.setOffline(true)`.
 * ---------------------------------------------------------------------- */

describe("the three states are kept apart", () => {
  it("no network is `offline`", () => {
    expect(
      classifyObservation({
        kind: "transport-failed",
        onLineWhenIssued: false,
        onLineWhenFailed: false
      })
    ).toEqual({ kind: "offline" });
    expect(classifyObservation({ kind: "browser-offline" })).toEqual({ kind: "offline" });
  });

  it("nothing answered WHILE the browser has a network is the SIDECAR, not the network", () => {
    /*
     * The case this product has and a website does not. The page is served by
     * a loopback process inside the desktop shell; if it dies the browser is
     * perfectly online and every same-origin request fails. Telling a viewer
     * "you are offline" here sends them to restart a router that works.
     */
    expect(
      classifyObservation({
        kind: "transport-failed",
        onLineWhenIssued: true,
        onLineWhenFailed: true
      })
    ).toEqual({ kind: "sidecar-unreachable" });
  });

  it("an ANSWER naming an unreachable provider is the backend, not the sidecar", () => {
    /* It answered -- so the sidecar is alive and the network carried it. What
     * failed is upstream of both. */
    expect(
      classifyObservation({ kind: "answered", reasonCode: "provider_unavailable" })
    ).toEqual({ kind: "service-unavailable", code: "provider_unavailable" });
  });

  it("the three produce three different headings, which is the point of keeping them apart", () => {
    const headings = (
      [
        { kind: "offline" },
        { kind: "sidecar-unreachable" },
        { kind: "service-unavailable", code: "provider_unavailable" }
      ] satisfies Reachability[]
    ).map((state) => describeDegradation(state)?.heading);

    expect(new Set(headings).size).toBe(3);
    expect(headings).not.toContain(undefined);
  });
});

describe("what must NOT raise a banner", () => {
  it("`reachable` says nothing at all", () => {
    expect(describeDegradation({ kind: "reachable" })).toBeNull();
  });

  it("a REFUSAL is the product working, not a reachability problem", () => {
    /*
     * `not_authenticated` is a 401 a viewer can act on and
     * `rights_not_established` is a rights decision. A banner reading
     * "unavailable" for either would be the collapse the acceptance forbids,
     * pointing the other way -- and `playbackSessionReasonCodeSchema` says so
     * itself: that code "is the viewer's, and it is the only reason in this
     * vocabulary whose remedy the viewer themselves can carry out."
     */
    for (const code of ["not_authenticated", "rights_not_established", "no_candidates_resolved"]) {
      expect(classifyObservation({ kind: "answered", reasonCode: code })).toEqual({
        kind: "reachable"
      });
    }
  });

  it("does NOT prefix-match on `provider`", () => {
    /*
     * `provider_health_below_floor` is a per-candidate ranking decision about
     * a provider that answered perfectly well. A viewer told "the service is
     * down" because one candidate scored badly would be told something false,
     * and a `startsWith("provider")` implementation would do exactly that.
     */
    expect(isServiceUnavailableCode("provider_health_below_floor")).toBe(false);
    expect(classifyObservation({ kind: "answered", reasonCode: "provider_health_below_floor" }))
      .toEqual({ kind: "reachable" });
  });

  it("an answer with no reason, or a code nobody published, is reachable", () => {
    expect(classifyObservation({ kind: "answered" })).toEqual({ kind: "reachable" });
    expect(classifyObservation({ kind: "answered", reasonCode: null })).toEqual({
      kind: "reachable"
    });
    expect(classifyObservation({ kind: "answered", reasonCode: "something_new" })).toEqual({
      kind: "reachable"
    });
  });
});

describe("the allowlist is the API's vocabulary, not a second one", () => {
  it("every playback code it names is a member of the published enum", () => {
    /*
     * The rule `lib/catalog.ts` follows for the rights allowlist and
     * `lib/episode-progress.ts` follows for the finished threshold: consume
     * the published vocabulary rather than restating it. A code renamed in the
     * contract fails here instead of silently never matching again -- which is
     * the failure mode that matters, because a banner that stops appearing
     * looks exactly like a product that stopped breaking.
     */
    const published = new Set(playbackSessionReasonCodeSchema.options);
    const fromPlayback = ["provider_unavailable", "provider_not_configured", "authentication_not_configured"];
    for (const code of fromPlayback) {
      expect(published.has(code as never), `${code} is no longer in the session contract`).toBe(true);
      expect(isServiceUnavailableCode(code)).toBe(true);
    }
  });

  it("classifies each listed code as transient or configuration, and nothing else", () => {
    for (const [code, kind] of Object.entries(SERVICE_UNAVAILABLE_CODES)) {
      expect(["transient", "configuration"], `${code}`).toContain(kind);
    }
  });

  it("offers a retry only where retrying could work", () => {
    /*
     * A retry button that cannot succeed is a worse answer than no button.
     * `provider_unavailable` is "the network's problem" and may clear on its
     * own; the configuration codes do not change until an operator acts.
     */
    expect(describeDegradation({ kind: "service-unavailable", code: "provider_unavailable" })?.retryable).toBe(true);
    for (const code of ["provider_not_configured", "storage_not_configured", "database_url_malformed"] as const) {
      expect(describeDegradation({ kind: "service-unavailable", code })?.retryable).toBe(false);
    }
    /* And offline offers none, because the `online` event recovers it without
     * anybody pressing anything. */
    expect(describeDegradation({ kind: "offline" })?.retryable).toBe(false);
  });
});

describe("the copy names what is unavailable and invents nothing", () => {
  const states: readonly Reachability[] = [
    { kind: "offline" },
    { kind: "sidecar-unreachable" },
    { kind: "service-unavailable", code: "provider_unavailable" },
    { kind: "service-unavailable", code: "provider_not_configured" }
  ];

  it.each(states)("%j has a heading and a body", (state) => {
    const copy = describeDegradation(state);
    expect(copy).not.toBeNull();
    expect(copy?.heading.length).toBeGreaterThan(0);
    expect(copy?.body.length).toBeGreaterThan(0);
  });

  it("puts no reason code in front of a viewer", () => {
    /*
     * The state PANELS elsewhere in this application publish a code, and
     * should -- they are read by somebody filing a bug. A persistent banner is
     * read by everybody, and `storage_not_configured` on it is a support
     * burden rather than a help.
     */
    for (const state of states) {
      const copy = describeDegradation(state);
      const text = `${copy?.heading ?? ""} ${copy?.body ?? ""}`;
      for (const code of Object.keys(SERVICE_UNAVAILABLE_CODES)) {
        expect(text, `${code} leaked into the banner`).not.toContain(code);
      }
    }
  });

  it("does not tell an offline viewer their computer is broken, or the reverse", () => {
    /* The support burden the acceptance names, in its concrete form: two
     * remedies, and each state must point at its own. */
    const offline = describeDegradation({ kind: "offline" });
    const sidecar = describeDegradation({ kind: "sidecar-unreachable" });
    expect(offline?.body).toContain("network");
    expect(sidecar?.body).toContain("Your network is fine");
    expect(sidecar?.body).toContain("restarting the application");
  });
});

describe("folding observations together, so the banner does not flicker", () => {
  it("one successful answer does not erase a failure another request just reported", () => {
    /*
     * A page makes several requests at once. If any success cleared the state,
     * a dead sidecar would produce a banner that blinks on and off -- and
     * flicker is worse than silence, because it teaches a viewer to ignore it.
     */
    const degraded: Reachability = { kind: "sidecar-unreachable" };
    expect(nextReachability(degraded, { kind: "answered", reasonCode: "not_authenticated" }))
      .toEqual({ kind: "reachable" });
  });

  it("a newer failure replaces an older one, because its remedy is the live one", () => {
    expect(
      nextReachability(
        { kind: "offline" },
        { kind: "transport-failed", onLineWhenIssued: true, onLineWhenFailed: true }
      )
    ).toEqual({ kind: "sidecar-unreachable" });
    expect(
      nextReachability({ kind: "sidecar-unreachable" }, { kind: "browser-offline" })
    ).toEqual({ kind: "offline" });
  });

  it("`online` clears the state so the application will TRY -- it is not proof", () => {
    /*
     * The subtlest line in the module. The browser fires `online` when an
     * interface comes up, which is why `navigator.onLine` is famously
     * optimistic -- true on a captive portal, true on a connected interface
     * with no route. Clearing is right: the next real observation decides, and
     * leaving the banner up would strand a recovered machine. Treating it as
     * proof would be the lie.
     */
    expect(nextReachability({ kind: "offline" }, { kind: "browser-online" })).toEqual({
      kind: "reachable"
    });
    /* And the very next transport failure puts it straight back. */
    expect(
      nextReachability(
        { kind: "reachable" },
        { kind: "transport-failed", onLineWhenIssued: true, onLineWhenFailed: true }
      )
    ).toEqual({ kind: "sidecar-unreachable" });
  });

  it("is idempotent for an unchanged state", () => {
    const state: Reachability = { kind: "service-unavailable", code: "provider_unavailable" };
    expect(
      nextReachability(state, { kind: "answered", reasonCode: "provider_unavailable" })
    ).toEqual(state);
  });
});

describe("reading a reason off whatever came back", () => {
  it("takes the first code of an `unavailable` envelope", () => {
    expect(
      unavailableReasonCode({
        outcome: "unavailable",
        reasons: [{ code: "provider_unavailable", detail: "the backend did not answer" }]
      })
    ).toBe("provider_unavailable");
  });

  it("ignores a `refused` envelope entirely", () => {
    /* A refusal is a decision, and a banner about reachability has no business
     * reacting to one. */
    expect(
      unavailableReasonCode({ outcome: "refused", reasons: [{ code: "not_authenticated" }] })
    ).toBeNull();
  });

  it.each([
    [null],
    [undefined],
    ["a string"],
    [42],
    [{}],
    [{ outcome: "unavailable" }],
    [{ outcome: "unavailable", reasons: [] }],
    [{ outcome: "unavailable", reasons: "no" }],
    [{ outcome: "unavailable", reasons: [null] }],
    [{ outcome: "unavailable", reasons: [{ detail: "no code" }] }],
    [{ outcome: "unavailable", reasons: [{ code: 7 }] }]
  ])("answers null for %j rather than throwing", (body) => {
    /*
     * Defensive for the reason `parseWatchlistAnswer` is: this runs against
     * whatever a proxy, a captive portal or a future version of a route
     * returned. Everything unrecognised is "answered, nothing wrong", which is
     * the direction that draws no UI.
     */
    expect(() => unavailableReasonCode(body)).not.toThrow();
    expect(unavailableReasonCode(body)).toBeNull();
  });
});

describe("a request that STRADDLED a transition is not evidence about the sidecar", () => {
  /* -----------------------------------------------------------------------
   * THE DEFECT THIS SUITE WAS EXTENDED FOR, AND IT WAS A REAL ONE THAT REACHED
   * A RUNNING BROWSER.
   *
   * The first version of `ReachabilityObservation` carried a single `onLine`,
   * read where the rejection was caught. `e2e/tests/degraded-states.spec.ts`
   * failed twice with the banner stuck on "Project Liberty stopped
   * responding", and the Playwright traces say exactly why: `/api/health` was
   * issued while the machine was offline, `navigator.onLine` had already
   * flipped back to `true` by the time the rejection arrived, and the next
   * request fifteen milliseconds later returned 200. A dead link was reported
   * as a dead process, and because nothing retried it stayed reported.
   *
   * Reading the browser's opinion at BOTH ends makes the straddle visible, and
   * these are the two orders it can happen in.
   * -------------------------------------------------------------------- */

  it("issued offline, rejected after the link returned, is the LINK", () => {
    expect(
      classifyObservation({
        kind: "transport-failed",
        onLineWhenIssued: false,
        onLineWhenFailed: true
      })
    ).toEqual({ kind: "offline" });
  });

  it("issued online, rejected after the link dropped, is also the LINK", () => {
    expect(
      classifyObservation({
        kind: "transport-failed",
        onLineWhenIssued: true,
        onLineWhenFailed: false
      })
    ).toEqual({ kind: "offline" });
  });

  it("only an unbroken online window accuses the sidecar", () => {
    /* NON-VACUITY for the two above: with both readings online the verdict is
     * still `sidecar-unreachable`, so the rule narrows the accusation rather
     * than removing it. */
    expect(
      classifyObservation({
        kind: "transport-failed",
        onLineWhenIssued: true,
        onLineWhenFailed: true
      })
    ).toEqual({ kind: "sidecar-unreachable" });
  });
});

describe("a failure is confirmed before it is published, and the confirming TERMINATES", () => {
  /* -----------------------------------------------------------------------
   * THE SECOND HALF OF THE SAME FIX. Reading `onLine` twice catches a probe
   * that straddled a transition; it does not catch one issued and rejected
   * entirely inside a window where the link was nominally up but the network
   * stack had not finished coming back. "Project Liberty stopped responding"
   * is the most consequential sentence this module can put on a screen -- it
   * tells a viewer their software is dead -- and one rejected request is not
   * enough to say it.
   *
   * WHAT MAKES THIS NOT A POLL. The schedule is reachable only from a
   * rejection, every input terminates, and a healthy application never enters
   * it. `degraded-banner.test.tsx` enforces the structural half of that rule
   * against the two source files.
   * -------------------------------------------------------------------- */

  it("hands back each delay in order and then STOPS", () => {
    const seen: number[] = [];
    for (let failures = 1; failures <= 50; failures += 1) {
      const delay = confirmationDelay(failures);
      if (delay === null) break;
      seen.push(delay);
    }
    expect(seen).toEqual([...LIVENESS_CONFIRMATION_DELAYS_MS]);
    expect(confirmationDelay(LIVENESS_CONFIRMATION_DELAYS_MS.length + 1)).toBeNull();
  });

  it("is bounded, and bounded SMALL -- this is a confirmation, not a retry budget", () => {
    expect(LIVENESS_CONFIRMATION_DELAYS_MS.length).toBeGreaterThan(0);
    expect(LIVENESS_CONFIRMATION_DELAYS_MS.length).toBeLessThanOrEqual(3);
    expect(MAX_LIVENESS_ATTEMPTS).toBe(LIVENESS_CONFIRMATION_DELAYS_MS.length + 1);
  });

  it("names a dead sidecar inside a second, because a viewer is waiting on the answer", () => {
    /* The whole confirmation window, not one delay. A correct banner that
     * arrives after the viewer has given up is not a correct banner. */
    const total = LIVENESS_CONFIRMATION_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeLessThanOrEqual(1_000);
    for (const delay of LIVENESS_CONFIRMATION_DELAYS_MS) expect(delay).toBeGreaterThan(0);
  });

  it("refuses nonsense rather than scheduling on it", () => {
    for (const input of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(confirmationDelay(input)).toBeNull();
    }
  });
});

describe("an answer is not a statement about the LINK", () => {
  /* -----------------------------------------------------------------------
   * THE THIRD DEFECT THE BROWSER FOUND, AND THE MOST EXPENSIVE OF THE THREE.
   *
   * A liveness probe already on the wire when the connection dropped resolved
   * a few milliseconds AFTER the `offline` event. The old fold read any answer
   * as recovery, cleared `offline`, and the banner called `router.refresh()`.
   * Next cannot fetch an RSC payload with no network and falls back to a full
   * browser navigation -- so the entire application was replaced by the
   * browser's error page, on a product whose acceptance says "an offline home
   * shows what it has and says so".
   *
   * The asymmetry that fixes it is a true statement about browsers rather than
   * a workaround: `navigator.onLine === true` is optimistic, `false` is not a
   * guess. And on this product an answer proves even less than usual -- the
   * page is served from a loopback process that answers with the wifi off.
   * -------------------------------------------------------------------- */

  it("does not clear `offline`, however healthy the answer looked", () => {
    expect(nextReachability({ kind: "offline" }, { kind: "answered" })).toEqual({
      kind: "offline"
    });
    expect(
      nextReachability({ kind: "offline" }, { kind: "answered", reasonCode: null })
    ).toEqual({ kind: "offline" });
  });

  it("DOES clear the two states that are not about the link", () => {
    /* NON-VACUITY, and the reason this is a narrowing rather than a refusal to
     * recover: something got through, so whatever was unreachable is not. */
    expect(
      nextReachability({ kind: "sidecar-unreachable" }, { kind: "answered" })
    ).toEqual({ kind: "reachable" });
    expect(
      nextReachability(
        { kind: "service-unavailable", code: "provider_unavailable" },
        { kind: "answered" }
      )
    ).toEqual({ kind: "reachable" });
  });

  it("leaves the browser's own event as the only thing that retracts `offline`", () => {
    expect(nextReachability({ kind: "offline" }, { kind: "browser-online" })).toEqual({
      kind: "reachable"
    });
  });
});
