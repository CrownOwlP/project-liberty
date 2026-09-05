import {
  collectCmcdEventReport,
  log,
  type CmcdRejection,
  type LogEvent
} from "@liberty/observability";
import { CMCD_SFV_LIMITS, decodeCmcdEventReportBody, type CmcdDecodeRefusal } from "./cmcd-sfv";
import {
  CMCD_JSON_REPORT_MEDIA_TYPE,
  CMCD_REPORT_MEDIA_TYPE,
  cmcdCollectorHttpStatus,
  cmcdCollectorReason,
  cmcdCollectorResponseSchema,
  cmcdJsonReportSchema,
  collectedReport,
  refusedReport,
  type CmcdCollectorRefusal,
  type CmcdCollectorResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * The HTTP half of POST /api/v1/telemetry/cmcd
 *
 * Separated from `route.ts` because a Next route module may only export the
 * handlers and a fixed set of segment config values -- so a route file has
 * nowhere to accept an injected clock or sink, and testing one means testing it
 * against the wall clock and the real console. This file takes the options;
 * `route.ts` is the adapter that supplies none. Same split, same reason, as
 * `api/v1/playback/session/handler.ts`.
 *
 * THE PRIVACY ARGUMENT, STRUCTURALLY.
 *
 * 1. THE ONLY THING THIS FILE LOGS IS `collectCmcdEventReport`'s OUTPUT. Not
 *    the body, not the decoded dictionaries, not the request headers. That
 *    output has already been through `safeString`, which has no branch that
 *    returns a raw value for a URL-bearing key and redacts any string under any
 *    key that merely looks like a URL. There is no second path from the request
 *    to a sink for a later edit to forget about, because there is no other call
 *    to `log` here.
 * 2. NO REQUEST HEADER BECOMES DATA. `content-type` and `content-length` are
 *    read to decide how to parse and whether to parse at all, and nothing else
 *    is read at all -- no cookie, no `user-agent`, no `referer`, no forwarded
 *    address. In particular `requestId` is passed to the collector as `null`
 *    rather than being taken from a correlation header: a header value is
 *    unbounded attacker-controlled text, it would land in every log line this
 *    request produces, and CMCD already carries `sid` and `cid`, which are
 *    non-URL identifiers designed for exactly that correlation job.
 * 3. NOTHING FROM THE BODY REACHES THE RESPONSE. Refusals are
 *    `{ stage, reason, key, count }`, `key` is populated only by the collector
 *    and only for keys the registry recognises, and the decoder's refusals carry
 *    no key at all. A parse failure does not quote what failed to parse.
 *
 * WHAT THE MEDIA-TYPE ALLOWLIST IS ALSO DOING. A cross-site form or `<img>`
 * POST can only carry `text/plain`, `multipart/form-data` or
 * `application/x-www-form-urlencoded` -- the three types that need no CORS
 * preflight -- and all three are refused with a 415 here. The two types this
 * endpoint does read are both preflighted, and nothing in this file answers an
 * `OPTIONS`. So a browser on another origin cannot make a viewer's browser post
 * a report as them. That is a consequence of refusing rather than sniffing, and
 * it is written down so a later "just accept text/plain too" does not throw it
 * away by accident.
 *
 * WHY THE TEXT SEARCH THAT WOULD "PROVE" THIS IS THE WRONG TEST. A response or
 * a log line from this endpoint legitimately contains the string `url`: it is a
 * CMCD KEY NAME, so `cmcd.url` is a field name in every record that carried one.
 * `telemetry.test.ts` records the same trap from the other side, where a search
 * for `"url"` matched the collector target's own `url` property and reported a
 * leak that was not there. The property that matters is that no URL VALUE
 * survives, which is asserted by searching for the signature and the path -- and
 * `cmcd-collect.test.ts` already walks the whole registry doing exactly that.
 * ---------------------------------------------------------------------- */

/**
 * Never cached, at any layer.
 *
 * The body is a receipt for one client's report. There is nothing in it a
 * shared cache could serve to a second caller that would be true for them.
 */
const NO_STORE = { "cache-control": "no-store" };

export interface CmcdCollectorOptions {
  /**
   * Supplies `receivedAtMs`. Injected rather than read here so a test pins the
   * one number in the record that would otherwise differ per run --
   * `collectCmcdEventReport` is a pure mapping precisely so that this is the
   * only clock in the pipeline, and it takes the instant as an argument.
   */
  readonly now?: () => Date;
  /**
   * Where structured records go. Defaults to `@liberty/observability`'s `log`,
   * which is the process log; `docs/RESEARCH_PLAYBACK.md` rules that CMCD
   * converts to OpenTelemetry at this boundary, and `LogEvent` is already the
   * attribute shape an OTel logs exporter attaches to, so that is a wiring
   * change here rather than a redesign.
   */
  readonly sink?: (event: LogEvent) => void;
}

/**
 * The media type, without its parameters, lowercased.
 *
 * `application/cmcd; charset=utf-8` is the same request as `application/cmcd`.
 * Nothing is sniffed: an absent or unrecognised header is refused rather than
 * guessed at, because a collector that guesses will one day parse something
 * that was not a report.
 */
function readMediaType(header: string | null): string | null {
  if (header === null) return null;
  const separator = header.indexOf(";");
  const type = (separator === -1 ? header : header.slice(0, separator)).trim().toLowerCase();
  return type === "" ? null : type;
}

/**
 * `content-length`, when it is a usable number.
 *
 * `null` for absent, malformed or negative. A chunked request has no
 * `content-length` at all, so this is a cheap early refusal and not the
 * authoritative bound; see `handleCmcdReportRequest` for the one that is.
 */
function declaredBodyBytes(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number(header);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * The body as text, or `null` if it could not be read.
 *
 * A body that fails mid-read -- an aborted upload, a truncated connection -- is
 * a malformed request rather than a server fault. Letting the rejection
 * propagate would turn the most ordinary network event into a 500, and a 5xx
 * from this endpoint is the one answer that makes a client RESEND the batch.
 */
async function readBodyText(request: Request): Promise<string | null> {
  try {
    return await request.text();
  } catch {
    return null;
  }
}

/** The decoded events, or the reason there are none. */
type DecodeOutcome =
  | { readonly ok: true; readonly events: readonly Readonly<Record<string, unknown>>[] }
  | { readonly ok: false; readonly response: CmcdCollectorResponse };

/**
 * The JSON spelling of the envelope.
 *
 * `unrecognized_keys` is picked out of the issue list rather than collapsed
 * into a generic schema failure, because it is the one failure with a different
 * meaning for the client: it says the field you sent is not accepted here,
 * which is the whole reason the schema is `.strict()`. A client whose extra
 * field was silently stripped learns nothing.
 */
function decodeJsonReport(body: string): DecodeOutcome {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return {
      ok: false,
      response: refusedReport(
        [],
        cmcdCollectorReason(
          "body_not_decodable",
          `A body sent as ${CMCD_JSON_REPORT_MEDIA_TYPE} was not valid JSON.`
        )
      )
    };
  }

  const parsed = cmcdJsonReportSchema.safeParse(parsedJson);
  if (parsed.success) return { ok: true, events: parsed.data.events };

  const rejectedAField = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys");
  return {
    ok: false,
    response: refusedReport(
      [],
      rejectedAField
        ? cmcdCollectorReason(
            "field_not_permitted",
            "This collector accepts a CMCD event report and nothing else. The request carried a " +
              "top-level field that is not `events`, and it was refused rather than stripped: " +
              "the only identifiers this endpoint accepts are CMCD's own `sid` and `cid`, inside " +
              "an event."
          )
        : cmcdCollectorReason(
            "report_envelope_invalid",
            "A JSON body must be `{ events: [ { <cmcd key>: <value> } ] }` with at most " +
              "the batch limit's worth of events."
          )
    )
  };
}

/** The `application/cmcd` spelling. See `cmcd-sfv.ts`. */
function decodeStructuredFieldReport(body: string): {
  readonly outcome: DecodeOutcome;
  readonly refusals: readonly CmcdCollectorRefusal[];
} {
  const decoded = decodeCmcdEventReportBody(body);
  const refusals = decoded.refusals.map(toCollectorRefusal);

  if (decoded.events.length > 0) {
    return { outcome: { ok: true, events: decoded.events }, refusals };
  }

  const wasEmpty = decoded.refusals.some(
    (refusal: CmcdDecodeRefusal) => refusal.reason === "body_empty"
  );
  return {
    refusals,
    outcome: {
      ok: false,
      response: refusedReport(
        refusals,
        wasEmpty
          ? cmcdCollectorReason(
              "body_empty",
              `A ${CMCD_REPORT_MEDIA_TYPE} body carried no event lines at all.`
            )
          : cmcdCollectorReason(
              "body_not_decodable",
              "No line of the report parsed as an RFC 8941 structured-field dictionary. See the " +
                "refusal list for which encoding rule each line broke; the offending text is " +
                "deliberately not quoted back."
            )
      )
    }
  };
}

function toCollectorRefusal(refusal: CmcdDecodeRefusal): CmcdCollectorRefusal {
  return { stage: "decode", reason: refusal.reason, key: null, count: refusal.count };
}

function toCollectRefusal(rejection: CmcdRejection): CmcdCollectorRefusal {
  return {
    stage: "collect",
    reason: rejection.reason,
    key: rejection.key,
    count: rejection.count
  };
}

/**
 * A total order over refusals.
 *
 * By stage, then reason, then key, by code point -- the same comparator shape
 * every other ordering in this pipeline uses. Both input lists are already
 * sorted within themselves; concatenating them is not, and an unsorted response
 * would make an identical body produce two different receipts depending on
 * which stage happened to refuse first.
 */
function compareRefusals(left: CmcdCollectorRefusal, right: CmcdCollectorRefusal): number {
  if (left.stage !== right.stage) return left.stage < right.stage ? -1 : 1;
  if (left.reason !== right.reason) return left.reason < right.reason ? -1 : 1;
  const leftKey = left.key ?? "";
  const rightKey = right.key ?? "";
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? -1 : 1;
}

/**
 * One line summarising what the DECODER refused, when it refused anything.
 *
 * The collector's own rejections already ride into each event's record as
 * `telemetry.rejectReasons`, so they need no second sink. The decoder's do not
 * belong to any one event -- a line that did not parse produced no event -- so
 * without this they would exist only in a response nobody keeps. Every value in
 * here is one of our own reason codes and a count; none of it comes from the
 * request.
 */
function decodeSummary(refusals: readonly CmcdCollectorRefusal[]): LogEvent | null {
  const decodeRefusals = refusals.filter((refusal) => refusal.stage === "decode");
  if (decodeRefusals.length === 0) return null;

  return {
    level: "warn",
    event: "playback.cmcd.decode_refused",
    fields: {
      "telemetry.decodeRefusals": decodeRefusals
        .map((refusal) => `${refusal.reason}=${String(refusal.count)}`)
        .join(",")
    }
  };
}

export async function handleCmcdReportRequest(
  request: Request,
  options: CmcdCollectorOptions = {}
): Promise<Response> {
  const response = await collectReport(request, options);

  /*
   * Validated against the published contract before it leaves the server, the
   * same way the playback session and catalog routes are. The reason is not
   * paranoia about our own object literals: `reasons` being non-empty on every
   * branch is a product invariant, and an invariant nothing checks at runtime
   * is one a later refactor can quietly drop.
   *
   * This is the only 5xx this route can produce, and it is the only one that
   * SHOULD be: a client that receives it is right to retry, because the fault
   * is ours. See `cmcdCollectorHttpStatus` for why every refusal about the
   * request is a 4xx instead.
   */
  const parsed = cmcdCollectorResponseSchema.safeParse(response);
  if (!parsed.success) {
    return Response.json(
      { error: "cmcd_collector_failed_validation", issues: parsed.error.issues },
      { status: 500, headers: NO_STORE }
    );
  }

  return Response.json(parsed.data, {
    status: cmcdCollectorHttpStatus(parsed.data),
    headers: NO_STORE
  });
}

async function collectReport(
  request: Request,
  options: CmcdCollectorOptions
): Promise<CmcdCollectorResponse> {
  const mediaType = readMediaType(request.headers.get("content-type"));
  if (mediaType !== CMCD_REPORT_MEDIA_TYPE && mediaType !== CMCD_JSON_REPORT_MEDIA_TYPE) {
    return refusedReport(
      [],
      cmcdCollectorReason(
        "content_type_not_supported",
        `This collector reads ${CMCD_REPORT_MEDIA_TYPE} (shaka-player's CMCD v2 Event Mode ` +
          `body: newline-delimited RFC 8941 dictionaries) and ${CMCD_JSON_REPORT_MEDIA_TYPE} ` +
          "(the same report already decoded). An unlabelled body is refused rather than sniffed."
      )
    );
  }

  const declared = declaredBodyBytes(request.headers.get("content-length"));
  if (declared !== null && declared > CMCD_SFV_LIMITS.maxBodyBytes) {
    return refusedReport([], bodyTooLarge());
  }

  const body = await readBodyText(request);
  if (body === null) {
    return refusedReport(
      [],
      cmcdCollectorReason(
        "body_unreadable",
        "The request body could not be read to the end. An aborted or truncated upload is a " +
          "malformed request, not a server fault, so this is a 4xx and the batch should not be " +
          "resent unchanged."
      )
    );
  }

  /*
   * The authoritative bound, and it is deliberately conservative in the safe
   * direction. `body.length` counts UTF-16 code units, and a UTF-8 encoding is
   * never SHORTER than that -- every code unit costs at least one byte -- so a
   * body over the limit in code units is certainly over it in bytes. The
   * `content-length` check above is the exact one and runs first; this catches
   * the chunked case, where there is no declared length to check.
   */
  if (body.length > CMCD_SFV_LIMITS.maxBodyBytes) return refusedReport([], bodyTooLarge());

  const decoded =
    mediaType === CMCD_REPORT_MEDIA_TYPE
      ? decodeStructuredFieldReport(body)
      : { outcome: decodeJsonReport(body), refusals: [] as readonly CmcdCollectorRefusal[] };

  if (!decoded.outcome.ok) return decoded.outcome.response;

  const receivedAtMs = (options.now ?? (() => new Date()))().getTime();
  const collected = collectCmcdEventReport({
    payload: { events: decoded.outcome.events },
    receivedAtMs,
    /* See the file header: never a correlation header. CMCD's own `sid` is the
     * identifier this pipeline correlates on. */
    requestId: null
  });

  const refusals = [...decoded.refusals, ...collected.rejections.map(toCollectRefusal)].sort(
    compareRefusals
  );

  if (!collected.ok) {
    /*
     * Reachable only if the envelope this file built is not one the collector
     * accepts, which today means an `events` that is not an array. Both decode
     * paths produce an array, so this is a guard against a future edit rather
     * than an observed input -- and it is a refusal rather than an assertion
     * because an unauthenticated endpoint has no business throwing.
     */
    return refusedReport(
      refusals,
      cmcdCollectorReason(
        "report_envelope_invalid",
        "The decoded report was not an event report the collector could read."
      )
    );
  }

  if (collected.logs.length === 0) {
    /*
     * `{ "events": [] }` is a well-formed report that says nothing. It reaches
     * here rather than the decoder's `body_empty` branch because the JSON
     * envelope permits an empty array, and it is refused rather than answered
     * `collected: 0` because "we accepted zero events" and "we accepted your
     * events" are different facts and the response type keeps them apart.
     */
    return refusedReport(
      refusals,
      cmcdCollectorReason("body_empty", "The report carried no events, so nothing was recorded.")
    );
  }

  const sink = options.sink ?? log;
  const summary = decodeSummary(refusals);
  if (summary !== null) sink(summary);
  for (const event of collected.logs) sink(event);

  return collectedReport(
    collected.logs.length,
    refusals,
    cmcdCollectorReason(
      "report_collected",
      `${String(collected.logs.length)} event(s) were converted to structured records. ` +
        `${String(refusals.length)} distinct refusal(s) are listed; a refused key does not ` +
        "discard the event that carried it."
    )
  );
}

function bodyTooLarge() {
  return cmcdCollectorReason(
    "body_too_large",
    `A report body is limited to ${String(CMCD_SFV_LIMITS.maxBodyBytes)} bytes. A legitimate ` +
      "batch is a few kilobytes; the bound is what one unauthenticated POST may make this " +
      "server hold."
  );
}
