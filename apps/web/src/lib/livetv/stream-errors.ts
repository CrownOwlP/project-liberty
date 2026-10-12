/* -------------------------------------------------------------------------
 * STREAM FAILURE REPORTING THAT NAMES THE CLASS AND LEAKS NOTHING
 * (Wave 132, Worker E).
 *
 * THE DEFECT CLASS REMOVED: THE ERROR MESSAGE THAT IS AN EXFILTRATION CHANNEL. A
 * playback failure is the single most-copied string in any media application. It
 * goes into a screenshot, a support ticket, a public issue tracker and a log
 * aggregator, and the thing it most often contains is the URL that failed —
 * which for an authorized live feed is a signed manifest address whose query
 * string IS the credential. `apps/web/src/app/api/v1/playback/session/authorized-candidates.ts`
 * keeps the credential-bearing address off the ranking path for the same reason;
 * this module keeps it off the REPORTING path.
 *
 * THE MECHANISM IS A TYPE, NOT A CONVENTION. `StreamFailureReport` has no field
 * capable of holding a URL. `classifyStreamFailure` takes raw text, decides a
 * class from it, and never carries the text forward — the only free-text field
 * on the output is `redactedDetail`, which is produced by `redactStreamDetail`
 * and which `stream-errors.test.ts` attacks with addresses, bearer tokens, query
 * strings, basic-auth userinfo and base64 blobs.
 *
 * THE SECOND HALF, AND IT MATTERS AS MUCH: THE CLASS IS NAMED. "Playback failed"
 * is useless to a viewer and useless to an operator. A closed vocabulary of
 * failure classes maps one-to-one onto remedies — wait, retry, check the
 * network, nothing you can do, an operator must configure something — and
 * `describeStreamFailure` is the single place each class's viewer-facing sentence
 * lives, so two surfaces cannot word the same failure two ways.
 *
 * AND A FAILURE IS NEVER RENDERED AS AN EMPTY STATE. `feed_not_configured` and
 * `channel_not_authorized` are failures with a stated cause, not an absence of
 * channels, which is the distinction `lib/catalog.ts`'s four empty causes draw.
 * ---------------------------------------------------------------------- */

export const STREAM_FAILURE_CLASSES = [
  /** No licensed feed is configured for this installation. The shipped state today. */
  "feed_not_configured",
  /** A channel with no rights basis we hold. Not retryable, and not the viewer's fault. */
  "channel_not_authorized",
  /** The manifest could not be reached at all: DNS, connection, TLS. */
  "manifest_unreachable",
  /** The manifest was reached and refused us: 401, 403, an expired signature. */
  "manifest_rejected",
  /** The manifest parsed to something this player cannot play. */
  "manifest_unsupported",
  /** Encrypted content and no licence this process may use. */
  "drm_licence_unavailable",
  /** The browser or OS declined to decode the media. */
  "decode_failed",
  /** The device has no usable network at all. */
  "network_offline",
  /** A step exceeded its deadline. Distinct from unreachable: something answered, slowly. */
  "timed_out",
  /** Classified as nothing above. Reported as unknown rather than guessed at. */
  "unclassified"
] as const;
export type StreamFailureClass = (typeof STREAM_FAILURE_CLASSES)[number];

export interface StreamFailureReport {
  readonly failureClass: StreamFailureClass;
  /** Whether trying again could plausibly succeed. Drives whether a retry is offered. */
  readonly retryable: boolean;
  /** Whether the remedy belongs to an operator rather than to the viewer. */
  readonly operatorAction: boolean;
  /**
   * Short, redacted context for a log. NEVER a URL, a token or a credential, and
   * `""` when redaction left nothing. There is deliberately no field on this
   * type that could hold the original text.
   */
  readonly redactedDetail: string;
}

/**
 * Replace anything address- or secret-shaped with a placeholder.
 *
 * ORDER MATTERS AND IS DELIBERATE: whole URLs first, then userinfo, then
 * bearer-style tokens, then query fragments, then long opaque blobs, then bare
 * hosts and addresses. Each pattern is applied to the output of the last, so a
 * URL already replaced cannot be re-matched into something that looks safe.
 *
 * THE RULE IS DENY-BY-SHAPE, NOT BY NAME. A redactor keyed on parameter names
 * (`token`, `key`, `signature`) only ever covers the names whoever wrote it
 * thought of — which is the exact failure `packages/net-policy/src/classify.ts`
 * documents for host spellings, where three separate CVE-shaped defects were all
 * "a spelling the comparison did not anticipate". Anything with a scheme, an
 * `@`, a `?`, a dotted host or 20+ characters of base64-looking text goes,
 * whatever it is called.
 */
export function redactStreamDetail(detail: string): string {
  let text = detail.slice(0, 400);

  text = text.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g, "[address removed]");
  text = text.replace(/[^\s:/@]+:[^\s:/@]+@[^\s/]+/g, "[credential removed]");
  text = text.replace(/\b(?:bearer|token|apikey|api_key|key|signature|sig|hdnts|auth)\b\s*[:=]?\s*\S+/gi, "[credential removed]");
  text = text.replace(/\?[^\s"']+/g, "[query removed]");
  text = text.replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[opaque value removed]");
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "[address removed]");
  text = text.replace(/\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(?::\d+)?\b/gi, "[host removed]");

  return text.replace(/\s+/g, " ").trim();
}

interface FailureSignals {
  /** Anything the player, the adapter or the transport said. Redacted before use. */
  readonly detail?: string;
  /** An HTTP status, when one was observed. */
  readonly status?: number;
  /** Whether the device reports itself offline. From `lib/network-state.ts`' concern. */
  readonly offline?: boolean;
  /** Set when the caller already knows the class — a rights refusal, say. */
  readonly knownClass?: StreamFailureClass;
}

/**
 * Decide a failure class, then forget the evidence.
 *
 * `knownClass` is honoured first, because the two classes that matter most here
 * — `feed_not_configured` and `channel_not_authorized` — are decisions THIS
 * codebase made, not symptoms to be inferred from a message. Inferring a rights
 * refusal from text would be reading our own gate's output as free text, which
 * is the failure `@liberty/contracts/domains/failover` describes for
 * provider-authored strings.
 */
export function classifyStreamFailure(signals: FailureSignals): StreamFailureReport {
  const redactedDetail = redactStreamDetail(signals.detail ?? "");

  const build = (
    failureClass: StreamFailureClass,
    retryable: boolean,
    operatorAction: boolean
  ): StreamFailureReport => ({ failureClass, retryable, operatorAction, redactedDetail });

  if (signals.knownClass !== undefined) {
    switch (signals.knownClass) {
      case "feed_not_configured":
        return build("feed_not_configured", false, true);
      case "channel_not_authorized":
        return build("channel_not_authorized", false, true);
      default:
        break;
    }
  }

  if (signals.offline === true) return build("network_offline", true, false);

  const status = signals.status;
  if (status !== undefined) {
    if (status === 401 || status === 403) return build("manifest_rejected", false, false);
    if (status === 404 || status === 410) return build("manifest_unreachable", false, true);
    if (status === 408 || status === 504) return build("timed_out", true, false);
    if (status >= 500) return build("manifest_unreachable", true, false);
  }

  if (signals.knownClass !== undefined) {
    return build(signals.knownClass, signals.knownClass !== "unclassified", false);
  }

  /*
   * Text matching is the LAST resort and it is matched against the lower-cased
   * REDACTED text, so a pattern can never be satisfied by something inside a URL
   * that has already been removed.
   */
  const text = redactedDetail.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) return build("timed_out", true, false);
  if (text.includes("decode") || text.includes("not supported")) return build("decode_failed", false, false);
  if (text.includes("licence") || text.includes("license") || text.includes("drm")) {
    return build("drm_licence_unavailable", false, true);
  }
  if (text.includes("manifest")) return build("manifest_unsupported", false, true);
  if (text.includes("network") || text.includes("connection")) {
    return build("manifest_unreachable", true, false);
  }
  return build("unclassified", true, false);
}

/**
 * The sentence a viewer reads. One per class, in one place.
 *
 * Total over the union with no `default`, so adding a class is a compile error
 * here rather than an unexplained blank panel in front of somebody.
 */
export function describeStreamFailure(failureClass: StreamFailureClass): string {
  switch (failureClass) {
    case "feed_not_configured":
      return "This installation has no licensed live feed configured, so there are no channels to play. Nothing is wrong with your account, and retrying will not change the answer until an operator configures one.";
    case "channel_not_authorized":
      return "We hold no rights to carry this channel, so it cannot be played here.";
    case "manifest_unreachable":
      return "We couldn't reach this channel's stream. This is usually temporary.";
    case "manifest_rejected":
      return "This channel's provider refused our request for the stream.";
    case "manifest_unsupported":
      return "This channel's stream is in a form this player cannot read.";
    case "drm_licence_unavailable":
      return "This channel is protected and no playback licence is available here.";
    case "decode_failed":
      return "This device declined to decode the channel's video or audio.";
    case "network_offline":
      return "This device has no network connection, so live channels cannot play.";
    case "timed_out":
      return "The channel took too long to start. Trying again may work.";
    case "unclassified":
      return "Playback failed for a reason we could not identify.";
  }
}
