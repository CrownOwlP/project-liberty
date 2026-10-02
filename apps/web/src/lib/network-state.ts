/* -------------------------------------------------------------------------
 * What is unreachable, and whose problem it is (PW-0309)
 *
 * THERE IS NO OFFLINE HANDLING OF ANY KIND IN THIS APPLICATION TODAY -- no
 * `navigator.onLine`, no reconnect, no banner -- and the acceptance says why
 * that matters more here than it did on the web: `docs/DESKTOP_PLAYBACK.md`
 * section 8 accepts that an offline desktop cannot resolve playback at all,
 * and requires the failure be surfaced as an honest unavailable outcome rather
 * than an empty candidate list. This module is the UI half of that ruling.
 *
 * ==========================================================================
 * IT PROBES NOTHING. IT CLASSIFIES WHAT THE APPLICATION ALREADY LEARNED
 * ==========================================================================
 *
 * The obvious design is a poller against a health endpoint. It was rejected
 * twice over.
 *
 * `/api/health` IS LIVENESS ONLY AND MUST STAY THAT WAY. Its own header: "A
 * health endpoint is the one route that is reachable unauthenticated from
 * everywhere by design, so every fact added to it is a fact published to
 * everyone, and 'which build is running' is reconnaissance rather than
 * health." Whether this deployment's backend is reachable is exactly that kind
 * of fact. Adding it would hand an unauthenticated caller a monitoring view of
 * the operator's infrastructure in order to draw a banner.
 *
 * AND A POLLER MEASURES THE WRONG THING. A request that succeeds every ten
 * seconds says nothing about the request the viewer just made and that failed.
 * What a degraded banner should report is what the application ACTUALLY
 * experienced, which is already carried on every answer this product gives:
 * the API answers in a published reason vocabulary, and a transport failure is
 * a thrown `fetch`. So callers report observations and this module names the
 * state.
 *
 * ==========================================================================
 * THE THREE STATES THE ACCEPTANCE ASKS TO BE KEPT APART
 * ==========================================================================
 *
 * "the sidecar being down is a DISTINCT state from the backend being down and
 * from the network being down, because the three have different remedies and
 * collapsing them produces a support burden."
 *
 * The distinction is not invented here. `playbackSessionReasonCodeSchema`
 * already draws it and says so in its own comments: `provider_unavailable` and
 * `provider_not_configured` "are the operator's and the network's problems",
 * while `not_authenticated` "is the viewer's, and it is the only reason in
 * this vocabulary whose remedy the viewer themselves can carry out". This
 * module consumes that vocabulary rather than writing a second one, which is
 * the rule `lib/catalog.ts` follows for the rights allowlist and
 * `lib/episode-progress.ts` follows for the finished-threshold.
 *
 * WHAT TELLS THEM APART, mechanically:
 *
 *   a same-origin request threw      + the browser says offline -> the network
 *   a same-origin request threw      + the browser says online  -> the sidecar
 *   a request was ANSWERED, and the answer says the provider could not be
 *   reached                                                     -> the backend
 *
 * The middle one is the case this product has that a website does not. The
 * page is served from a loopback sidecar inside the desktop shell; if that
 * process dies the browser is still perfectly online and every same-origin
 * request fails. Telling a viewer "you are offline" then would send them to
 * restart a router that is working.
 * ---------------------------------------------------------------------- */

/**
 * Reason codes that mean the SERVICE answered and reported something upstream
 * of it is unavailable.
 *
 * A SMALL EXPLICIT ALLOWLIST, not a prefix match on "provider". A prefix would
 * sweep in `provider_health_below_floor`, which is a per-candidate ranking
 * decision about a provider that answered perfectly well -- a viewer told "the
 * service is down" because one candidate scored badly would be told something
 * false. The three below are the ones whose meaning is "we could not get an
 * answer from upstream", and each is listed with whose problem it is, because
 * that is what decides the copy.
 */
export const SERVICE_UNAVAILABLE_CODES = {
  /** The network's problem, upstream of us. Retrying later is reasonable. */
  provider_unavailable: "transient",
  /** The operator's problem. Retrying changes nothing until they act. */
  provider_not_configured: "configuration",
  /** The operator's problem too, and a different subsystem. */
  authentication_not_configured: "configuration",
  /** Storage, same shape, from `lib/db/request-context.ts`'s vocabulary. */
  storage_not_configured: "configuration",
  database_url_malformed: "configuration"
} as const satisfies Readonly<Record<string, "transient" | "configuration">>;

export type ServiceUnavailableCode = keyof typeof SERVICE_UNAVAILABLE_CODES;

export function isServiceUnavailableCode(code: string): code is ServiceUnavailableCode {
  return Object.hasOwn(SERVICE_UNAVAILABLE_CODES, code);
}

/**
 * What the application currently believes it can reach.
 *
 * `reachable` IS THE DEFAULT AND IT IS NOT A CLAIM. It means nothing has gone
 * wrong that this module was told about -- not that anything was checked. The
 * banner renders nothing for it, so an untested assumption draws no UI, which
 * is the direction this has to fail in.
 */
export type Reachability =
  | { readonly kind: "reachable" }
  | { readonly kind: "offline" }
  | { readonly kind: "sidecar-unreachable" }
  | { readonly kind: "service-unavailable"; readonly code: ServiceUnavailableCode };

/**
 * Something the application learned by trying.
 *
 * `onLine` IS PASSED IN RATHER THAN READ HERE, which is what keeps this module
 * pure and testable in a `node` environment with no `navigator`. It is also
 * the honest shape: `navigator.onLine` is the BROWSER's opinion and is
 * famously optimistic -- true on a captive portal, true on a connected
 * interface with no route -- so it is one input to a decision rather than the
 * decision.
 */
export type ReachabilityObservation =
  /**
   * A same-origin `fetch` rejected: nothing was answered.
   *
   * THE BROWSER'S OPINION IS READ TWICE, AND THE SECOND READING IS NOT
   * REDUNDANCE -- it is the fix for a defect this task shipped and then caught
   * in a browser. The first version carried one `onLine`, sampled where the
   * rejection was caught. A request issued while the machine was offline can
   * reject a few milliseconds AFTER the network comes back, and at that moment
   * `navigator.onLine` is already `true` -- so a failure caused by a dead link
   * was classified as a dead sidecar, and the viewer was told the application
   * had stopped responding while it was answering perfectly well. Two
   * Playwright traces show it exactly: `/api/health` rejects, and the next
   * request 15 ms later returns 200.
   *
   * A verdict about a process is only supportable if the link was up for the
   * WHOLE request. One sample cannot say that; two can.
   */
  | {
      readonly kind: "transport-failed";
      /** `navigator.onLine` when the request was handed to the browser. */
      readonly onLineWhenIssued: boolean;
      /** `navigator.onLine` when the rejection was caught. */
      readonly onLineWhenFailed: boolean;
    }
  /** A request was answered. `reasonCode` is the first code of an `unavailable` envelope, if any. */
  | { readonly kind: "answered"; readonly reasonCode?: string | null }
  /** The browser's own `offline` event. */
  | { readonly kind: "browser-offline" }
  /** The browser's own `online` event. */
  | { readonly kind: "browser-online" };

/**
 * The state one observation implies, on its own.
 *
 * TOTAL AND PURE. Every branch is reachable and none of them reads a clock, a
 * global or the DOM.
 */
export function classifyObservation(observation: ReachabilityObservation): Reachability {
  switch (observation.kind) {
    case "browser-offline":
      return { kind: "offline" };

    case "transport-failed":
      /*
       * THE SIDECAR CASE, which is the one a web application does not have.
       * Nothing answered, and the browser believes it has a network -- so the
       * thing that did not answer is the loopback process serving this page.
       * Reporting "you are offline" here would send a viewer to restart a
       * router that is working.
       *
       * BOTH READINGS MUST SAY ONLINE. A request that straddled a transition
       * -- issued offline and rejected after the link returned, or the reverse
       * -- failed because of the link, and `offline` is the honest name for
       * it. See the type above for the trace that forced this.
       */
      return observation.onLineWhenIssued && observation.onLineWhenFailed
        ? { kind: "sidecar-unreachable" }
        : { kind: "offline" };

    case "answered": {
      const code = observation.reasonCode;
      if (typeof code === "string" && isServiceUnavailableCode(code)) {
        return { kind: "service-unavailable", code };
      }
      /*
       * ANYTHING ELSE THAT WAS ANSWERED IS REACHABILITY-OK, INCLUDING A
       * REFUSAL. `not_authenticated` is a 401 and `rights_not_established` is
       * a rights decision; both are the product working. A banner that said
       * "unavailable" for them would be the collapse the acceptance forbids,
       * pointing the other way.
       */
      return { kind: "reachable" };
    }

    case "browser-online":
      /*
       * AN `online` EVENT IS NOT PROOF OF ANYTHING, and this is the subtlest
       * line in the module. The browser fires it when an interface comes up,
       * which is why `navigator.onLine` is famously optimistic. It clears the
       * state to `reachable` so the application will TRY again -- and the next
       * real observation is what decides. Treating it as proof would replace
       * an honest "offline" with an honest-looking lie; treating it as nothing
       * would leave a recovered machine showing a stale banner forever.
       */
      return { kind: "reachable" };
  }
}

/**
 * Fold an observation into what is already believed.
 *
 * WHY THIS IS NOT JUST `classifyObservation`. A page makes several requests at
 * once. One of them answering normally must not erase a real failure another
 * one just reported, or a banner would flicker on and off while the sidecar
 * stayed dead -- and flicker is worse than silence, because it teaches a
 * viewer to ignore it.
 *
 * THE RULE: a degraded state is only cleared by something that MEANS recovery
 * -- a successful answer, or the browser's `online` event -- and a degraded
 * state is always replaced by a newer degraded state, because the most recent
 * failure is the one with the live remedy.
 */
export function nextReachability(
  current: Reachability,
  observation: ReachabilityObservation
): Reachability {
  const observed = classifyObservation(observation);

  if (observed.kind !== "reachable") return observed;

  /*
   * ==========================================================================
   * AN ANSWER DOES NOT CLEAR `offline`, AND THAT ASYMMETRY IS THE WHOLE POINT
   * ==========================================================================
   *
   * `navigator.onLine` is unreliable in ONE DIRECTION ONLY. `true` is famously
   * optimistic -- a captive portal, an interface with no route. `false` is the
   * browser saying there is no usable interface at all, and it is not guessing
   * about that. So an `offline` state is the browser's own statement, and the
   * only thing entitled to retract it is the browser's `online` event.
   *
   * WHY IT HAS TO BE SAID OUT LOUD HERE: on this product an answer proves less
   * than it looks like it proves. The page is served by a loopback process
   * inside the desktop shell, so `/api/health` answers perfectly well with the
   * machine's wifi switched off. Letting any answer clear `offline` therefore
   * says "the network is back" on the evidence of a request that never touched
   * the network.
   *
   * IT WAS NOT A THEORETICAL HOLE. A liveness probe already in flight when the
   * link dropped resolved a few milliseconds AFTER the `offline` event; the
   * banner read that as a recovery, called `router.refresh()`, Next could not
   * fetch the RSC payload with no network, and -- by design -- fell back to a
   * full browser navigation. On a desktop application that means the entire
   * product is replaced by the browser's own error page. The traced sequence
   * is in `reachability-store.test.ts`.
   *
   * A degraded state that is NOT the link still clears on an answer, which is
   * what makes this a narrowing rather than a refusal to recover: something
   * got through, so whatever was unreachable is reachable now.
   */
  if (observation.kind === "answered") {
    return current.kind === "offline" ? current : { kind: "reachable" };
  }

  /* `browser-online` clears it for the reason given above -- it is permission
   * to try, not proof, and it is the browser retracting its own statement. */
  if (observation.kind === "browser-online") return { kind: "reachable" };

  return current;
}

/** What the viewer is told. Never invented at the call site. */
export interface DegradedCopy {
  /** What is unavailable, named. */
  readonly heading: string;
  /** What it means for them right now. */
  readonly body: string;
  /** Whether trying again could plausibly help. Decides whether a retry is offered. */
  readonly retryable: boolean;
}

/**
 * The sentence for a state, or `null` when there is nothing to say.
 *
 * THE COPY NAMES WHAT IS UNAVAILABLE, which the acceptance asks for in terms,
 * and it names nothing else. No reason code reaches a viewer here: a code is
 * for a bug report and the state panels elsewhere in this application publish
 * one, but a persistent banner is read by everybody and `storage_not_configured`
 * on it is a support burden rather than a help.
 *
 * NO STATE INVENTS CONTENT -- the acceptance's fourth clause. Each of these
 * says what could not be reached and what that costs, and none of them claims
 * anything about what the catalog, the list or the player would have shown.
 */
export function describeDegradation(state: Reachability): DegradedCopy | null {
  switch (state.kind) {
    case "reachable":
      return null;

    case "offline":
      return {
        heading: "You're offline",
        body:
          "This device has no network connection. Anything already on screen is still here; " +
          "nothing new can be loaded and nothing can be played until the connection comes back.",
        /* No retry control: there is nothing for one to do, and the `online`
         * event recovers this state without anybody pressing anything. */
        retryable: false
      };

    case "sidecar-unreachable":
      return {
        heading: "Project Liberty stopped responding",
        body:
          "Your network is fine — the part of the application running on this computer did not " +
          "answer. Nothing you have done is lost. If this does not clear, restarting the " +
          "application will bring it back.",
        retryable: true
      };

    case "service-unavailable":
      return SERVICE_UNAVAILABLE_CODES[state.code] === "transient"
        ? {
            heading: "The playback service is unreachable",
            body:
              "Your connection and this computer are both fine — the service that resolves " +
              "what to play did not answer. Browsing still works; playback will not until it " +
              "is back.",
            retryable: true
          }
        : {
            heading: "This installation is not fully configured",
            body:
              "Part of this installation has not been set up, so some features cannot work. " +
              "This is not something trying again will fix — it needs whoever installed it.",
            /* Stated as false deliberately. `provider_not_configured` and the
             * storage codes do not change until an operator acts, and a retry
             * button that cannot succeed is a worse answer than no button. */
            retryable: false
          };
  }
}

/**
 * Pull the first reason code out of whatever a route answered.
 *
 * DEFENSIVE FOR THE REASON `parseWatchlistAnswer` IS: this runs against
 * whatever a proxy, a captive portal or a future version of a route returned,
 * and `fetch` hands back `unknown`. Anything that is not an `unavailable`
 * envelope with a reason trail answers `null`, which `classifyObservation`
 * then reads as "answered, nothing wrong" -- the direction that draws no UI.
 *
 * ONLY `unavailable` IS READ. `refused` is the product working: a refusal is a
 * decision, and a banner about reachability has no business reacting to one.
 */
export function unavailableReasonCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record["outcome"] !== "unavailable") return null;
  const reasons = record["reasons"];
  if (!Array.isArray(reasons)) return null;
  const first: unknown = reasons[0];
  if (typeof first !== "object" || first === null) return null;
  const code = (first as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/* =========================================================================
 * CONFIRMING A FAILURE BEFORE PUBLISHING IT
 * ========================================================================= */

/**
 * How long to wait before each re-attempt of a liveness check that failed.
 *
 * WHY A FAILED PROBE IS A HYPOTHESIS RATHER THAN A VERDICT. "Project Liberty
 * stopped responding" is the most consequential sentence this module can put
 * on a screen: it tells a viewer the software they are using is dead and
 * invites them to restart it. Inferring that from ONE rejected request is not
 * sound, and it was not sound in practice -- the two Playwright traces that
 * forced this constant show a probe rejecting at the instant a connection
 * returned, with the next request answering 200 fifteen milliseconds later,
 * and the banner then stating that the application had stopped responding for
 * as long as the page stayed open. Nothing retried, because nothing was
 * scheduled to.
 *
 * THIS IS NOT A POLL, AND THE DIFFERENCE IS STRUCTURAL RATHER THAN A MATTER OF
 * DEGREE. A poll is a schedule that exists while everything is fine; this list
 * is reachable only from a rejection, is finite, and is consumed in order. A
 * healthy application has no timer of any kind outstanding. `setInterval` --
 * a schedule that repeats until something cancels it -- remains forbidden
 * outright in `components/state`, and `degraded-banner.test.tsx` enforces both
 * halves of that rule.
 *
 * THE VALUES. Short enough that a genuinely dead sidecar is named inside a
 * second, which is faster than a viewer can act on the news; spread rather
 * than uniform, because the failure this is confirming against is a network
 * stack mid-transition and the useful second question is asked a little later
 * than the first.
 */
export const LIVENESS_CONFIRMATION_DELAYS_MS = [150, 500] as const;

/**
 * The pause before the next attempt, or `null` when the failure is confirmed.
 *
 * TOTAL, PURE, AND BOUNDED BY CONSTRUCTION -- the point of putting it here
 * rather than inlining a loop in the store. `failures` is how many attempts
 * have already rejected, counting from one, so the first call after the first
 * rejection asks `confirmationDelay(1)`. Anything outside the list answers
 * `null`, which is the caller's instruction to publish the failure and stop:
 * there is no input for which this schedules another attempt forever.
 */
export function confirmationDelay(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1) return null;
  return LIVENESS_CONFIRMATION_DELAYS_MS[failures - 1] ?? null;
}

/** How many requests one `checkLiveness` can make at the very most. */
export const MAX_LIVENESS_ATTEMPTS = LIVENESS_CONFIRMATION_DELAYS_MS.length + 1;
