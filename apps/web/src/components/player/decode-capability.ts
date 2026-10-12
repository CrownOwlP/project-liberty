/* -------------------------------------------------------------------------
 * What this client can decode, and what it is honestly allowed to claim
 * (W132-D, item 7)
 *
 * ==========================================================================
 * THE DEFECT CLASS: A HARDWARE-DECODING BADGE NOBODY MEASURED
 * ==========================================================================
 *
 * The feature as usually written reads `powerEfficient` out of
 * `MediaCapabilities.decodingInfo()` and renders "Hardware decoding: on". That
 * is a false claim in both directions and this module refuses to make it:
 *
 *  - `powerEfficient` IS NOT A HARDWARE-DECODE FLAG. The specification defines
 *    it as a user-agent judgement about power consumption. Chromium has
 *    returned `false` on desktop configurations that were in fact using a
 *    hardware decoder, and a user agent is permitted to answer conservatively
 *    or to answer the same thing for everything. A badge built on it is wrong
 *    on real machines.
 *  - `smooth` is likewise a PREDICTION, not an observation, and it is allowed
 *    to be a guess from a static table.
 *  - Neither says anything about the decoder actually chosen for the stream
 *    that is playing, which is the thing an operator reading a diagnostics
 *    panel believes they are being told.
 *
 * So the vocabulary below never contains the word "hardware" as an assertion.
 * It reports WHAT WAS ASKED, WHICH API ANSWERED, AND WHAT IT SAID, and the
 * strongest conclusion it will draw is `power_efficient_reported` — which names
 * its own source in the identifier so it cannot be read as a measurement.
 *
 * `unknown` IS A FIRST-CLASS ANSWER AND NOT AN ERROR. A WebView2 build with no
 * `navigator.mediaCapabilities`, a `decodingInfo` that rejects, a server render
 * with no `navigator` at all: all of them are "nobody knows", which is a
 * reading a diagnostics panel can display honestly. Defaulting to "supported"
 * would make a player claim a codec it cannot play; defaulting to
 * "unsupported" would make it refuse one it can. This is the same rule
 * `@liberty/media-engine` applies to an absent codec and the rule
 * `continueWatchingVerdict` applies to an unknown runtime.
 *
 * ==========================================================================
 * EVERY BROWSER READ IS BEHIND A `typeof` GUARD, IN A FUNCTION
 * ==========================================================================
 *
 * The lead is fixing a Windows-only client TypeError in the installed WebView2
 * build, so this file is written to the stricter rule: MODULE EVALUATION TOUCHES
 * NOTHING. `probeFromGlobals` is a function, every global it names is checked
 * with `typeof` before it is read, every call is wrapped, and a throw anywhere
 * inside becomes `null` — "no probe available" — rather than an exception out
 * of a render.
 *
 * `decodingInfo` is also wrapped because it can REJECT rather than throw
 * synchronously (an invalid configuration is a `TypeError` on the returned
 * promise in some engines and a synchronous throw in others), and a floating
 * rejection inside a client component is an unhandled rejection in the console
 * of a build somebody is already debugging.
 *
 * The probe is an INJECTED PORT so every branch below — including each failure
 * mode — is reachable in `environment: "node"` with no browser in existence.
 * ---------------------------------------------------------------------- */

/** What `MediaCapabilities.decodingInfo()` answers, as this module needs it. */
export interface DecodingInfoResult {
  readonly supported?: unknown;
  readonly smooth?: unknown;
  readonly powerEfficient?: unknown;
}

/**
 * The narrow boundary over whatever the host offers.
 *
 * Both members are OPTIONAL because both are genuinely absent on real targets:
 * `mediaCapabilities` is missing from older WebView2 and from every server
 * render, and `canPlayType` is missing from any double that is not an element.
 * A probe with neither is legal and answers `unknown` — which is the state this
 * module exists to be able to say out loud.
 */
export interface DecodeProbe {
  decodingInfo?: (configuration: unknown) => Promise<DecodingInfoResult>;
  canPlayType?: (mimeType: string) => string;
}

/** What the caller wants to know about. A video configuration, narrowly. */
export interface DecodeQuery {
  /** A full type with parameters, e.g. `video/mp4; codecs="avc1.640028"`. */
  readonly contentType: string;
  readonly widthPixels: number;
  readonly heightPixels: number;
  readonly bitrateBitsPerSecond: number;
  readonly framesPerSecond: number;
}

/**
 * The conclusion. Read the names literally: three of the five say who said so.
 *
 * `power_efficient_reported` is deliberately long. Someone writing a badge from
 * this union has to type the words "reported" and cannot accidentally render
 * the string as a fact about silicon.
 */
export type DecodeConclusion =
  /** No API answered. Nobody knows, and the panel must say so. */
  | "unknown"
  /** An API answered and said it cannot decode this configuration. */
  | "unsupported"
  /** Decodable; the user agent made no efficiency claim either way. */
  | "supported_efficiency_unknown"
  /** Decodable, and the user agent REPORTED power-efficient decoding. */
  | "power_efficient_reported"
  /** Decodable, and the user agent explicitly reported NOT power-efficient. */
  | "not_power_efficient_reported";

export type DecodeSource = "media-capabilities" | "can-play-type" | "none";

export interface DecodeCapability {
  readonly conclusion: DecodeConclusion;
  /** Which API produced it, so a reader can weigh it. */
  readonly source: DecodeSource;
  /** Verbatim from the API, `null` where it said nothing. Never inferred. */
  readonly supported: boolean | null;
  readonly smooth: boolean | null;
  readonly powerEfficient: boolean | null;
  /**
   * Why the answer is what it is, in one line, naming the API and the raw
   * values. Product invariant 4: a decision a viewer can feel carries a trail.
   */
  readonly reason: string;
}

const NOTHING_KNOWN: DecodeCapability = Object.freeze({
  conclusion: "unknown",
  source: "none",
  supported: null,
  smooth: null,
  powerEfficient: null,
  reason: "no decoding-capability API is available on this client"
});

/** `unknown` as a value, for a server render or a client with no probe. */
export function unknownDecodeCapability(): DecodeCapability {
  return NOTHING_KNOWN;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A probe built from the host globals, or `null` when there are none.
 *
 * NOTHING IS READ AT IMPORT TIME; see the header. `createElement` is attempted
 * last and inside its own `try`, because it is the only line here that
 * allocates anything, and a host with a `document` that throws on
 * `createElement` (a stripped webview, a test shim) must degrade to "no
 * `canPlayType`" rather than take the player down.
 */
export function probeFromGlobals(): DecodeProbe | null {
  const probe: DecodeProbe = {};

  try {
    if (
      typeof navigator !== "undefined" &&
      typeof (navigator as { mediaCapabilities?: unknown }).mediaCapabilities === "object" &&
      (navigator as { mediaCapabilities?: unknown }).mediaCapabilities !== null
    ) {
      const capabilities = (
        navigator as { mediaCapabilities: { decodingInfo?: unknown } }
      ).mediaCapabilities;
      if (typeof capabilities.decodingInfo === "function") {
        const decodingInfo = capabilities.decodingInfo as (
          configuration: unknown
        ) => Promise<DecodingInfoResult>;
        /* Bound to its owner: `decodingInfo` is a method and calling it detached
         * throws an illegal-invocation `TypeError` in Chromium — exactly the
         * class of client TypeError being chased in the WebView2 build. */
        probe.decodingInfo = (configuration: unknown) =>
          decodingInfo.call(capabilities, configuration);
      }
    }
  } catch {
    /* A host whose `navigator` getter throws. Nothing known from this source. */
  }

  try {
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      const element = document.createElement("video");
      if (typeof element.canPlayType === "function") {
        probe.canPlayType = (mimeType: string) => element.canPlayType(mimeType);
      }
    }
  } catch {
    /* No element could be made. `canPlayType` stays absent. */
  }

  return probe.decodingInfo === undefined && probe.canPlayType === undefined ? null : probe;
}

/**
 * The `MediaCapabilities` configuration for a query.
 *
 * Exported so a test can pin the shape, and because getting it wrong is how
 * `decodingInfo` comes to reject: the spec requires `framerate` to be positive
 * and finite and the dimensions to be positive integers, and a rejected promise
 * reads in a panel as "unsupported" when it means "we asked badly".
 */
export function decodingConfiguration(query: DecodeQuery): unknown {
  return {
    type: "media-source",
    video: {
      contentType: query.contentType,
      width: Math.max(1, Math.round(query.widthPixels)),
      height: Math.max(1, Math.round(query.heightPixels)),
      bitrate: Math.max(1, Math.round(query.bitrateBitsPerSecond)),
      framerate: query.framesPerSecond > 0 ? query.framesPerSecond : 24
    }
  };
}

/**
 * What this client can say about decoding one configuration.
 *
 * `MediaCapabilities` FIRST and `canPlayType` as a FALLBACK, never merged: the
 * two disagree routinely, and a merged answer would be a third opinion neither
 * API gave. `canPlayType` can only ever reach
 * `supported_efficiency_unknown` or `unsupported`, because `"probably"` is the
 * strongest word it has and it says nothing about efficiency at all —
 * promoting it would be inventing the claim this module exists to refuse.
 *
 * Never throws and never rejects. Every failure is `unknown` with the reason
 * attached.
 */
export async function detectDecodeCapability(
  query: DecodeQuery,
  probe: DecodeProbe | null
): Promise<DecodeCapability> {
  if (probe === null) return NOTHING_KNOWN;

  if (typeof probe.decodingInfo === "function") {
    try {
      const info = await probe.decodingInfo(decodingConfiguration(query));
      const supported = asBoolean(info?.supported);
      const smooth = asBoolean(info?.smooth);
      const powerEfficient = asBoolean(info?.powerEfficient);

      if (supported === false) {
        return Object.freeze({
          conclusion: "unsupported" as const,
          source: "media-capabilities" as const,
          supported,
          smooth,
          powerEfficient,
          reason: `MediaCapabilities.decodingInfo reported supported=false for ${query.contentType}`
        });
      }

      if (supported === true) {
        const conclusion: DecodeConclusion =
          powerEfficient === true
            ? "power_efficient_reported"
            : powerEfficient === false
              ? "not_power_efficient_reported"
              : "supported_efficiency_unknown";
        return Object.freeze({
          conclusion,
          source: "media-capabilities" as const,
          supported,
          smooth,
          powerEfficient,
          reason:
            `MediaCapabilities.decodingInfo reported supported=true, ` +
            `smooth=${String(smooth)}, powerEfficient=${String(powerEfficient)} ` +
            `for ${query.contentType}; power efficiency is the user agent's own ` +
            `judgement and is not evidence of a hardware decoder`
        });
      }
      /* `supported` was neither true nor false: an object that is not a
       * `MediaDecodingInfo`. Fall through to `canPlayType` rather than reading a
       * missing field as a yes or a no. */
    } catch {
      /* Threw or rejected. Fall through; the reason is recorded below. */
    }
  }

  if (typeof probe.canPlayType === "function") {
    try {
      const answer = probe.canPlayType(query.contentType);
      /* The three legal values are `"probably"`, `"maybe"` and `""`. Anything
       * else is a host that does not implement this, and is not read as a yes. */
      if (answer === "probably" || answer === "maybe") {
        return Object.freeze({
          conclusion: "supported_efficiency_unknown" as const,
          source: "can-play-type" as const,
          supported: true,
          smooth: null,
          powerEfficient: null,
          reason:
            `canPlayType answered "${answer}" for ${query.contentType}; it makes no ` +
            `claim about decoding efficiency, so none is made here`
        });
      }
      if (answer === "") {
        return Object.freeze({
          conclusion: "unsupported" as const,
          source: "can-play-type" as const,
          supported: false,
          smooth: null,
          powerEfficient: null,
          reason: `canPlayType answered "" for ${query.contentType}`
        });
      }
    } catch {
      /* Fall through to unknown. */
    }
  }

  return Object.freeze({
    ...NOTHING_KNOWN,
    reason:
      `no decoding-capability API answered for ${query.contentType}: ` +
      `decodingInfo ${probe.decodingInfo === undefined ? "absent" : "did not answer"}, ` +
      `canPlayType ${probe.canPlayType === undefined ? "absent" : "did not answer"}`
  });
}

/**
 * One line for a diagnostics panel, which must not overstate the finding.
 *
 * Each string is checked by a test for the words it may not contain. "Hardware
 * decoding" is not among them for any conclusion, because nothing above
 * observed one.
 */
export function describeDecodeCapability(capability: DecodeCapability): string {
  switch (capability.conclusion) {
    case "unknown":
      return "Decoding support: unknown on this client";
    case "unsupported":
      return "Decoding support: this configuration is reported as not decodable";
    case "supported_efficiency_unknown":
      return "Decoding support: decodable; efficiency not reported";
    case "power_efficient_reported":
      return "Decoding support: decodable; the browser reports power-efficient decoding";
    case "not_power_efficient_reported":
      return "Decoding support: decodable; the browser reports it is not power-efficient";
  }
}
