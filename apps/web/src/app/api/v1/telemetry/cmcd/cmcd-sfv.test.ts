import { describe, expect, it } from "vitest";
import { CMCD_REPORT_LIMITS, collectCmcdEventReport } from "@liberty/observability";
import { CMCD_SFV_LIMITS, decodeCmcdEventReportBody } from "./cmcd-sfv";

/* -------------------------------------------------------------------------
 * The wire decoder, under test.
 *
 * The fixtures are written in the shape `cml_sfv.js`'s `encodeSfDict` produces,
 * because that is the only encoder that will ever talk to this endpoint in
 * production: a bare key for a true boolean, `?0` for false, a token with no
 * quotes, a decimal that always carries a point, and an inner list whose members
 * carry their CMCD object type as a bare parameter.
 *
 * WHAT IS NOT TESTED HERE: which keys are legal, what a unit means, and what
 * gets redacted. All three belong to `@liberty/observability`, which has 68
 * tests about them. The one place this file crosses that line is the last
 * describe block, which checks that what the decoder produces is a shape the
 * collector actually reads -- a decoder that parsed perfectly into a structure
 * nothing downstream understood would pass every test above it.
 * ---------------------------------------------------------------------- */

/**
 * A line in the shape Shaka's Event Mode encoder emits.
 *
 * `bl`, `br` and `mtp` are written as INNER LISTS because CMCD v2 makes them
 * one -- `third_party/cml-cmcd/cmcd_inner_list_keys.js` is the list, and
 * `upConvertToV2` wraps a v1 scalar into an array for exactly these keys. A
 * fixture that wrote `br=3200` would be testing v1 and would be rejected by the
 * collector as a `wrong_type`, which is the correct answer to the wrong
 * question.
 */
const EVENT_LINE =
  'bl=(3000;v 2000;a),br=(3200;v),bs,cid="the-northstar-affair",d=4004,e=t,' +
  'msd=1500,mtp=(25400),ot=v,pr=1.0,sf=d,sid="3f2504e0-4f89-11d3-9a0c-0305e82c3301",st=v,sta=p,' +
  "ts=1700000000000";

/**
 * Decoded events as ORDINARY objects.
 *
 * The decoder builds each record with a null prototype, so that a key spelled
 * like something on `Object.prototype` is an own property rather than a setter
 * call. Spreading here is what lets the assertions below be written against
 * plain object literals.
 */
function eventsOf(body: string): Record<string, unknown>[] {
  return decodeCmcdEventReportBody(body).events.map((event) => ({ ...event }));
}

function decode(body: string): Record<string, unknown> {
  const first = eventsOf(body)[0];
  if (first === undefined) throw new Error("expected at least one decoded event");
  return first;
}

function reasons(body: string): string[] {
  return decodeCmcdEventReportBody(body).refusals.map((refusal) => refusal.reason);
}

describe("the shapes the SVTA encoder actually emits", () => {
  it("decodes a full event line", () => {
    const event = decode(EVENT_LINE);

    expect(event["br"]).toEqual([{ value: 3200, objectType: "v" }]);
    expect(event["mtp"]).toEqual([25400]);
    expect(event["cid"]).toBe("the-northstar-affair");
    expect(event["d"]).toBe(4004);
    expect(event["msd"]).toBe(1500);
    expect(event["ts"]).toBe(1_700_000_000_000);
    // Tokens arrive as bare strings, which is what the registry compares.
    expect(event["e"]).toBe("t");
    expect(event["ot"]).toBe("v");
    expect(event["sta"]).toBe("p");
  });

  it("reads a bare key as true, because that is how a true boolean is encoded", () => {
    // `encodeSfDict` writes no `=` at all when the value is `true`, so `bs=?1`
    // never occurs on the wire and `bs` alone is the ordinary case.
    expect(decode(EVENT_LINE)["bs"]).toBe(true);
    expect(decode("bs=?0")["bs"]).toBe(false);
    expect(decode("bs=?1")["bs"]).toBe(true);
  });

  it("keeps a decimal a decimal and an integer an integer", () => {
    // `serializeDecimal_` appends `.0` when rounding produced no point, so a
    // playback rate of exactly 1 arrives as `1.0`.
    expect(decode("pr=1.0")["pr"]).toBe(1);
    expect(decode("pr=0.75")["pr"]).toBe(0.75);
    expect(decode("ltc=-40")["ltc"]).toBe(-40);
  });

  it("turns an inner list into one value per CMCD object type", () => {
    // `bl=(3000;v 2000;a)` is the v2 form: an inner list whose members carry
    // their object type as a bare parameter.
    expect(decode("bl=(3000;v 2000;a)")["bl"]).toEqual([
      { value: 3000, objectType: "v" },
      { value: 2000, objectType: "a" }
    ]);
  });

  it("keeps an unqualified inner-list member unqualified", () => {
    expect(decode("bl=(1000 3000;v)")["bl"]).toEqual([1000, { value: 3000, objectType: "v" }]);
  });

  it("decodes a string list, escapes and all", () => {
    expect(decode('ec=("HTTP_ERROR" "MANIFEST_\\"quoted\\"")')["ec"]).toEqual([
      "HTTP_ERROR",
      'MANIFEST_"quoted"'
    ]);
    expect(decode('cs="a\\\\b"')["cs"]).toBe("a\\b");
  });

  it("does not validate the object type, because the collector owns that", () => {
    // `isCmcdObjectType` lives in `cmcd-keys.ts` and rejects an unknown one with
    // `unknown_token`. A second opinion here would be a second vocabulary.
    expect(decode("bl=(3000;zz)")["bl"]).toEqual([{ value: 3000, objectType: "zz" }]);
  });
});

describe("values CMCD has no key for are dropped, not guessed at", () => {
  it("discards a byte sequence without decoding it", () => {
    const body = 'cid="x",thing=:aGVsbG8=:';
    expect(eventsOf(body)).toEqual([{ cid: "x" }]);
    expect(decodeCmcdEventReportBody(body).refusals).toContainEqual({
      reason: "byte_sequence_discarded",
      count: 1
    });
  });

  it("discards a Date rather than reading it as a number", () => {
    /*
     * `serializeDate_` writes `@<seconds>`. CMCD's one wall-clock key, `ts`, is
     * epoch MILLISECONDS, so passing the number through would hand the collector
     * a timestamp a thousand times too small under a key typed to accept it.
     */
    expect(eventsOf("ts=@1700000000")).toEqual([{}]);
    expect(decodeCmcdEventReportBody("ts=@1700000000").refusals).toContainEqual({
      reason: "date_discarded",
      count: 1
    });
  });

  it("refuses an inner-list member whose parameters it cannot read", () => {
    expect(eventsOf("bl=(3000;v;x 2000;a)")).toEqual([{ bl: [{ value: 2000, objectType: "a" }] }]);
    expect(decodeCmcdEventReportBody("bl=(3000;v;x 2000;a)").refusals).toContainEqual({
      reason: "inner_list_item_unsupported",
      count: 1
    });
  });
});

describe("a malformed line costs one event, not the batch", () => {
  it("keeps every line that parsed", () => {
    const body = `br=1000\nthis is not a dictionary\nbr=2000\n`;
    expect(eventsOf(body)).toEqual([{ br: 1000 }, { br: 2000 }]);
    expect(decodeCmcdEventReportBody(body).refusals).toContainEqual({
      reason: "line_unparseable",
      count: 1
    });
  });

  it("refuses rather than throws, for every malformed shape", () => {
    for (const line of [
      "br=",
      "br=1,",
      ",br=1",
      "=1",
      "br=1;",
      'cid="unterminated',
      "bl=(3000",
      "br=?2",
      "br=1.2345",
      "br=99999999999999999999",
      "9br=1",
      "__proto__=1",
      "br=1 br=2"
    ]) {
      expect(() => decodeCmcdEventReportBody(line), line).not.toThrow();
      expect(decodeCmcdEventReportBody(line).events, line).toEqual([]);
      expect(reasons(line), line).toContain("line_unparseable");
    }
  });

  it("never quotes what it refused", () => {
    const secret = 'cid="SECRET-SIGNATURE" and then garbage';
    const result = decodeCmcdEventReportBody(secret);
    expect(JSON.stringify(result)).not.toContain("SECRET-SIGNATURE");
  });

  it("keeps the first value of a repeated key rather than letting the last win", () => {
    // "The last one wins" is an order dependence wearing a different hat. RFC
    // 8941 specifies last-wins; this deviates deliberately and counts it.
    expect(eventsOf("br=1000,br=2000")).toEqual([{ br: 1000 }]);
    expect(decodeCmcdEventReportBody("br=1000,br=2000").refusals).toContainEqual({
      reason: "duplicate_key",
      count: 1
    });
  });
});

describe("bounds", () => {
  it("truncates at the collector's own event limit", () => {
    const body = Array.from({ length: CMCD_REPORT_LIMITS.maxEvents + 3 }, () => "br=1000").join(
      "\n"
    );
    const result = decodeCmcdEventReportBody(body);
    expect(result.events.length).toBe(CMCD_REPORT_LIMITS.maxEvents);
    expect(result.refusals).toContainEqual({ reason: "line_batch_truncated", count: 3 });
  });

  it("refuses an over-long line without parsing it", () => {
    const line = `cs="${"x".repeat(CMCD_SFV_LIMITS.maxLineChars)}"`;
    expect(reasons(line)).toEqual(["line_too_long"]);
  });

  it("says so when there is nothing at all", () => {
    expect(reasons("")).toEqual(["body_empty"]);
    expect(reasons("\n\n  \n")).toEqual(["body_empty"]);
  });
});

describe("determinism", () => {
  it("decodes identical bytes to an identical result", () => {
    const body = `${EVENT_LINE}\nbr=1000,br=2000\nnot a dictionary\n`;
    expect(JSON.stringify(decodeCmcdEventReportBody(body))).toBe(
      JSON.stringify(decodeCmcdEventReportBody(body))
    );
  });

  it("sorts refusals by reason rather than by the order they happened", () => {
    const forwards = decodeCmcdEventReportBody("nope nope\nbr=1,br=2");
    const backwards = decodeCmcdEventReportBody("br=1,br=2\nnope nope");
    expect(forwards.refusals).toEqual(backwards.refusals);
    expect(forwards.refusals.map((refusal) => refusal.reason)).toEqual([
      "duplicate_key",
      "line_unparseable"
    ]);
  });

  it("tolerates the optional whitespace the encoder puts after each comma", () => {
    expect(decode("br=1000, d=4004")).toEqual(decode("br=1000,d=4004"));
  });
});

describe("what it hands the collector is a shape the collector reads", () => {
  const RECEIVED_AT = 1_700_000_000_000;

  it("produces fields with the collector's units and object-type slots", () => {
    const decoded = decodeCmcdEventReportBody(EVENT_LINE);
    const collected = collectCmcdEventReport({
      payload: { events: decoded.events },
      receivedAtMs: RECEIVED_AT,
      requestId: null
    });

    expect(collected.ok).toBe(true);
    const fields = collected.logs[0]?.fields ?? {};
    expect(fields["cmcd.msdMs"]).toBe(1500);
    expect(fields["cmcd.blMs.v"]).toBe(3000);
    expect(fields["cmcd.blMs.a"]).toBe(2000);
    expect(fields["cmcd.brKbps.v"]).toBe(3200);
    // The unqualified member of an inner list keeps the bare field name.
    expect(fields["cmcd.mtpKbps"]).toBe(25400);
    expect(fields["cmcd.tsEpochMs"]).toBe(1_700_000_000_000);
    expect(fields["cmcd.cid"]).toBe("the-northstar-affair");
    expect(collected.rejections).toEqual([]);
  });

  it("lets the collector redact a URL a client sent anyway", () => {
    /*
     * The client allowlist means `url` is never REQUESTED, but the collector is
     * reachable by anyone who can reach the player. This is the end-to-end
     * version of that: a URL-bearing key on the wire, redacted by the time it
     * is a record. The assertions search for the signature and the path rather
     * than for the string "url", which is a FIELD NAME in the output --
     * `telemetry.test.ts` records that trap from the other side.
     */
    const decoded = decodeCmcdEventReportBody(
      'url="https://cdn.example.com/movies/northstar/1080p.m3u8?Signature=SECRET-SIGNATURE"'
    );
    const collected = collectCmcdEventReport({
      payload: { events: decoded.events },
      receivedAtMs: RECEIVED_AT,
      requestId: null
    });

    const serialised = JSON.stringify(collected);
    expect(serialised).not.toContain("SECRET-SIGNATURE");
    expect(serialised).not.toContain("movies");
    expect(collected.logs[0]?.fields?.["cmcd.url"]).toBe("https://cdn.example.com/[redacted]");
  });
});
