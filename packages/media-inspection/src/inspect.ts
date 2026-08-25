import { parseDashLadder } from "./dash";
import { detectManifestFormat } from "./detect";
import type { EgressPolicy, HostClassifier, HostResolver } from "./egress";
import { parseHlsLadder } from "./hls";
import { fetchManifestText, type ManifestFetchFailure } from "./http";
import type { PinnedFetch } from "./pin";
import type {
  InspectionReason,
  InspectionReasonCode,
  InspectionResult,
  ManifestFormat,
  ManifestParseContext,
  ParsedLadder
} from "./types";

/* -------------------------------------------------------------------------
 * The media inspection service, manifest path.
 *
 * One call: given a rights decision that authorised a manifest URL, return what
 * the publisher DECLARED about the ladder, without opening a media segment.
 * ---------------------------------------------------------------------- */

/**
 * The rights decision that authorised this inspection.
 *
 * THE URL IS INSIDE THE AUTHORISATION, NOT BESIDE IT. The obvious signature
 * takes a URL and a token and checks that they match, which makes "inspect a URL
 * the decision did not name" a bug that a missing check can reintroduce. Here it
 * is not expressible: there is no other URL to pass. Inspection cannot be
 * pointed at anything a rights decision did not authorise, and product invariant
 * 1 does not depend on anybody remembering to compare two strings.
 *
 * This package performs NO rights evaluation of its own. It refuses an expired
 * authorisation because acting on a lapsed grant is this component's mistake to
 * avoid; everything else about eligibility belongs to PL-0501 and is not
 * second-guessed here.
 */
export interface InspectionAuthorization {
  /** Identifies the decision in the reason trail. Never a URL, never a secret. */
  readonly decisionId: string;
  /** The manifest URL the decision authorised, signature and all. */
  readonly manifestUrl: string;
  readonly expiresAtEpochMs: number;
}

export interface InspectionOptions {
  readonly egress: EgressPolicy;
  readonly timeoutMs: number;
  readonly maxManifestBytes: number;
  readonly maxRedirects: number;
  /**
   * The largest ladder we will accept, measured on what the publisher DECLARED.
   *
   * A two-megabyte MPD can declare tens of thousands of `Representation`s, and a
   * caller ranking them is doing work proportional to a number a publisher
   * chose. SO IS THIS PACKAGE, which is why the cap is checked where it is: the
   * limit is threaded into `ManifestParseContext` and each parser refuses the
   * moment the declared count is known, before a rung is built and before the
   * ladder is sorted by a comparator that stringifies several fields per
   * comparison. Nothing would have bounded that work in time -- `http.ts` clears
   * its deadline as soon as the body is in hand -- so a cap applied to the
   * PARSED ladder would have been a limit on the report rather than on the
   * process.
   *
   * Measured before duplicates collapse, which is not a detail: 20,000 identical
   * renditions canonicalise to one, so a post-parse cap would have done all of
   * the work and then reported a one-rung ladder as a success. It also means the
   * number is a work budget rather than a ladder-width budget -- a multi-period
   * MPD restates its ladder per `Period` -- and an operator with such a catalogue
   * raises it deliberately.
   *
   * Exceeding the cap REFUSES rather than truncating: a truncated ladder is not
   * the declared ladder, and it would be reported as though it were.
   */
  readonly maxRenditions: number;
  readonly userAgent: string;
}

export interface InspectionDependencies {
  /**
   * See `pin.ts` on why this is not `typeof fetch`. A Node composition root
   * supplies `nodePinnedFetch` from `@liberty/media-inspection/node/pinned-fetch`.
   */
  readonly fetchImpl: PinnedFetch;
  /** See `egress.ts` on why this is a required port with no default. */
  readonly classifyHost: HostClassifier;
  readonly resolveHost: HostResolver;
  readonly now: () => number;
}

/**
 * Limits somebody chose, exported so that callers spread them rather than
 * inventing numbers at each call site -- and so that changing one is one edit
 * with one review.
 *
 * They are NOT defaults: `InspectionOptions` has no optional fields, so a caller
 * states every limit even when it states them by spreading this. A hidden
 * default is a policy nobody reviewed.
 *
 * `maxManifestBytes` is two mebibytes. A master playlist is kilobytes; a
 * long-form multi-period MPD with a dense `SegmentTimeline` is the shape that
 * gets large, and two mebibytes covers a many-hour VOD while staying far below
 * anything that threatens the process. `maxRedirects` is three because a CDN
 * chain that needs a fourth hop is not a CDN chain.
 */
export const DEFAULT_INSPECTION_LIMITS = {
  timeoutMs: 5_000,
  maxManifestBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  maxRenditions: 256,
  userAgent: "ProjectLiberty-MediaInspection/0.1"
} as const;

/**
 * Which failures are OUR refusal and which are the publisher's or the network's.
 *
 * The split is by WHO DECIDED, and it is the difference between an operator
 * changing a policy and an operator retrying. Collapsing the two sends whoever
 * reads the trail to the wrong system, which is the failure mode invariant 4
 * exists to prevent.
 */
const PUBLISHER_OR_NETWORK_FAILURES: readonly ManifestFetchFailure[] = [
  "timeout",
  "network_error",
  "http_status",
  "redirect_without_location"
];

/**
 * The pure half of the service: text in, ladder out, no I/O.
 *
 * Exported because it is worth having on its own -- reprocessing a stored
 * manifest, a fixture, a test -- and because keeping the network and the parsing
 * separable is what stops the parsing from quietly acquiring a fetch.
 */
export function parseManifestLadder(
  text: string,
  format: ManifestFormat,
  context: ManifestParseContext
): ParsedLadder {
  return format === "hls" ? parseHlsLadder(text, context) : parseDashLadder(text, context);
}

export async function inspectManifest(
  authorization: InspectionAuthorization,
  options: InspectionOptions,
  deps: InspectionDependencies
): Promise<InspectionResult> {
  // Taken ONCE, so every fact from one manifest shares an instant and two facts
  // can never appear to disagree about when a single read happened.
  const observedAt = new Date(deps.now()).toISOString();

  const refused = (code: InspectionReasonCode, detail: string): InspectionResult => ({
    outcome: "refused",
    observedAt,
    format: null,
    reasons: [{ code, detail }]
  });

  const unavailable = (
    code: InspectionReasonCode,
    detail: string,
    format: ManifestFormat | null = null
  ): InspectionResult => ({ outcome: "unavailable", observedAt, format, reasons: [{ code, detail }] });

  if (deps.now() >= authorization.expiresAtEpochMs) {
    return refused(
      "authorization_expired",
      `decision ${sanitiseIdentifier(authorization.decisionId)} is no longer valid`
    );
  }

  const fetched = await fetchManifestText(
    authorization.manifestUrl,
    {
      egress: options.egress,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxManifestBytes,
      maxRedirects: options.maxRedirects,
      userAgent: options.userAgent
    },
    deps
  );

  if (!fetched.ok) {
    return PUBLISHER_OR_NETWORK_FAILURES.includes(fetched.reason)
      ? unavailable(fetched.reason, fetched.detail)
      : refused(fetched.reason, fetched.detail);
  }

  const format = detectManifestFormat(fetched.text);
  if (format === null) {
    return unavailable(
      "unrecognised_manifest_format",
      "the body is neither an HLS playlist nor an MPD"
    );
  }

  const parsed = parseManifestLadder(fetched.text, format, {
    observedAt,
    // The FINAL URL, after redirects. RFC 8216 resolves a variant URI against
    // where the playlist came from, and a redirecting CDN is exactly where the
    // requested URL and the delivered one differ.
    baseUrl: fetched.finalUrl,
    egress: options.egress,
    classifyHost: deps.classifyHost,
    // Handed to the parser rather than applied to its output, so that the cap
    // bounds the WORK and not just the report. See `maxRenditions` above.
    maxRenditions: options.maxRenditions
  });

  const fatal = parsed.reasons.find((reason) => reason.code === "manifest_unparseable");
  if (fatal !== undefined) {
    return unavailable(fatal.code, fatal.detail, format);
  }

  // A parser that refused on the declared count. OUR decision rather than the
  // publisher's failure, so it is `refused`, and the parser's own detail is kept
  // because it names the DECLARED count -- the number that explains the refusal.
  // Reporting the surviving count here would name a number nobody exceeded.
  const overLadderCap = parsed.reasons.find((reason) => reason.code === "too_many_renditions");
  if (overLadderCap !== undefined) {
    return { outcome: "refused", observedAt, format, reasons: [overLadderCap] };
  }

  // A BACKSTOP, and unreachable while both parsers honour the context: they
  // refuse on a count that canonicalisation can only shrink, so nothing that
  // gets past them can exceed the cap here. It is kept because the real check
  // now lives once per parser, and a THIRD parser wired into
  // `parseManifestLadder` that forgets to read `maxRenditions` would otherwise
  // have no cap at all. It cannot restore the work bound -- that work is already
  // done by the time this line runs -- so it is a guard on the REPORT only, and
  // is not the control this cap is documented as.
  if (parsed.renditions.length > options.maxRenditions) {
    return {
      outcome: "refused",
      observedAt,
      format,
      reasons: [
        {
          code: "too_many_renditions",
          detail: `${parsed.renditions.length} renditions exceeds the cap of ${options.maxRenditions}`
        }
      ]
    };
  }

  // A reason on the successful branch too. An outcome with no trail violates
  // invariant 4 whether it succeeded or not, and an empty array is what a
  // consumer learns to skip.
  const reasons: InspectionReason[] =
    parsed.reasons.length > 0
      ? [...parsed.reasons]
      : [
          {
            code: "ladder_read_from_manifest",
            detail: `${parsed.renditions.length} declared renditions read from a ${format} manifest`
          }
        ];

  return { outcome: "inspected", observedAt, format, renditions: parsed.renditions, reasons };
}

/**
 * A decision id, reduced to a shape that is safe to print.
 *
 * The id is ours rather than a publisher's, so this is belt and braces -- but
 * `detail` strings from this file end up in the same reason trail as strings
 * built from third-party input, and a reader cannot tell which is which. Keeping
 * one rule for all of them means the rule cannot be forgotten for the one that
 * turns out to matter.
 */
function sanitiseIdentifier(value: string): string {
  const trimmed = value.slice(0, 64);
  return /^[A-Za-z0-9._:-]*$/.test(trimmed) ? trimmed : "(non-printable id)";
}
