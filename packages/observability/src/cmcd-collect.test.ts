import { describe, expect, it } from "vitest";
import { collectCmcdEventReport, type CmcdCollectionResult } from "./cmcd-collect";
import { CMCD_V2_CLIENT_SAFE_KEYS, CMCD_V2_KEYS, cmcdKeySpec } from "./cmcd-keys";
import type { LogField } from "./log-event";
import { REDACTED } from "./redaction";

const SIGNED =
  "https://cdn.example.com/movies/northstar/1080p/seg-000012.m4s" +
  "?Policy=eyJTdGF0ZW1lbnQi&Signature=SECRET-SIGNATURE&Key-Pair-Id=APKAEXAMPLE";

const RECEIVED_AT = 1_700_000_000_000;

function collect(events: readonly Record<string, unknown>[]): CmcdCollectionResult {
  return collectCmcdEventReport({ payload: { events }, receivedAtMs: RECEIVED_AT, requestId: "req-1" });
}

function fieldsOf(result: CmcdCollectionResult, index = 0): Record<string, LogField> {
  const entry = result.logs[index];
  if (entry === undefined) throw new Error(`expected a log at index ${index}`);
  return entry.fields ?? {};
}

function nameOf(result: CmcdCollectionResult, index = 0): string {
  const entry = result.logs[index];
  if (entry === undefined) throw new Error(`expected a log at index ${index}`);
  return entry.event;
}

describe("units", () => {
  it("carries the unit in the field name wherever CTA-5004-B states one", () => {
    const fields = fieldsOf(
      collect([
        { e: "t", msd: 1500, ltc: 4000, ttfb: 250, ttlb: 900, ts: 1_700_000_000_123, rtp: 12_000 }
      ])
    );

    expect(fields["cmcd.msdMs"]).toBe(1500);
    expect(fields["cmcd.ltcMs"]).toBe(4000);
    expect(fields["cmcd.ttfbMs"]).toBe(250);
    expect(fields["cmcd.ttlbMs"]).toBe(900);
    expect(fields["cmcd.rtpKbps"]).toBe(12_000);
  });

  it("distinguishes an epoch instant from a duration in the name", () => {
    // `ts` is a wall-clock instant and `msd` is an elapsed span. Both are
    // milliseconds and neither is the other, so the suffixes differ.
    const fields = fieldsOf(collect([{ ts: 1_700_000_000_123, msd: 1500 }]));
    expect(fields["cmcd.tsEpochMs"]).toBe(1_700_000_000_123);
    expect(fields["cmcd.msdMs"]).toBe(1500);
  });

  it("refuses a start delay in seconds rather than recording 1.5 milliseconds", () => {
    /*
     * Shaka's `getStats()` is seconds throughout and CMCD is milliseconds
     * throughout; `docs/RESEARCH_PLAYBACK.md` names that as the most likely
     * unit bug in this area. The single conversion lives in the player, at
     * `apps/web/src/components/player/playback-stats.ts`, and this boundary
     * deliberately adds no second one — what it does instead is refuse a value
     * that is obviously still in seconds, because CTA-5004-B types `msd` as an
     * integer and 1.5 milliseconds is not a start delay anyone has measured.
     */
    const result = collect([{ msd: 1.5 }]);
    expect(fieldsOf(result)["cmcd.msdMs"]).toBeNull();
    expect(result.rejections).toContainEqual({ reason: "not_an_integer", key: "msd", count: 1 });
  });

  it("applies the seconds guard to every scalar time key, not just msd", () => {
    const result = collect([{ msd: 1.5, ltc: 4.0, ttfb: 0.25, d: 6.0 }]);
    const fields = fieldsOf(result);

    expect(fields["cmcd.msdMs"]).toBeNull();
    expect(fields["cmcd.ttfbMs"]).toBeNull();
    // `4.0` and `6.0` ARE integers in JavaScript, so a whole number of seconds
    // passes the guard. This is the guard's honest limit and it is written down
    // rather than papered over: the integer check catches a fraction, not a
    // plausible small integer. Nothing here can tell 4 ms from 4 s.
    expect(fields["cmcd.ltcMs"]).toBe(4);
    expect(fields["cmcd.dMs"]).toBe(6);
  });
});

describe("unavailable values", () => {
  it("turns NaN into null and never into zero", () => {
    /*
     * NaN survives arithmetic, comparison and JSON.stringify without ever
     * failing, so an unguarded NaN dropped-frame count becomes a reported
     * dropped-frame count of zero somewhere downstream — and zero is a claim.
     */
    const result = collect([{ dfa: Number.NaN, ltc: Number.POSITIVE_INFINITY, msd: 0 }]);
    const fields = fieldsOf(result);

    expect(fields["cmcd.dfa"]).toBeNull();
    expect(fields["cmcd.ltcMs"]).toBeNull();
    // A genuine zero survives as a zero. That is the whole reason `null` and
    // `0` have to be different values here.
    expect(fields["cmcd.msdMs"]).toBe(0);
    expect(result.rejections).toContainEqual({ reason: "not_finite", key: "dfa", count: 1 });
  });

  it("never lets one absent time field borrow another's number", () => {
    // The same defect shape as conflating Shaka's `loadLatency` with its
    // `timeToFirstFrame`: an absent measurement that silently reads as a
    // present one. Neither is a fallback for the other at either end.
    const fields = fieldsOf(collect([{ msd: Number.NaN, ltc: 4000 }]));
    expect(fields["cmcd.msdMs"]).toBeNull();
    expect(fields["cmcd.ltcMs"]).toBe(4000);
  });

  it("says nothing at all about a key the client simply did not send", () => {
    // Absent is not the same claim as unavailable. `null` asserts the client
    // looked; omission asserts nothing.
    const fields = fieldsOf(collect([{ msd: 1500 }]));
    expect(Object.keys(fields)).not.toContain("cmcd.ltcMs");
  });

  it("writes null rather than a number when the type is wrong", () => {
    const result = collect([{ msd: "1500" }]);
    expect(fieldsOf(result)["cmcd.msdMs"]).toBeNull();
    expect(result.rejections).toContainEqual({ reason: "wrong_type", key: "msd", count: 1 });
  });
});

describe("vocabulary", () => {
  it("ignores nrr, which CMCD v2 removed", () => {
    // The range information moved onto `nor`. The vendored SVTA table still
    // lists `nrr` because it also encodes v1, so a client CAN send it and mean
    // nothing valid by it.
    const result = collect([{ nrr: "0-1023", msd: 1500 }]);
    expect(Object.keys(fieldsOf(result))).not.toContain("cmcd.nrr");
    expect(fieldsOf(result)["cmcd.msdMs"]).toBe(1500);
    expect(result.rejections).toContainEqual({ reason: "removed_in_v2", key: "nrr", count: 1 });
  });

  it("drops a token outside its closed vocabulary rather than passing it through", () => {
    const result = collect([{ sta: "zzz", e: "ps" }]);
    expect(fieldsOf(result)["cmcd.sta"]).toBeNull();
    expect(result.rejections).toContainEqual({ reason: "unknown_token", key: "sta", count: 1 });
  });

  it("does not treat the prototype chain as vocabulary", () => {
    // `CMCD_V2_KEYS["toString"]` is a function at runtime while the index
    // signature types it as a spec.
    expect(cmcdKeySpec("toString")).toBeNull();
    expect(cmcdKeySpec("constructor")).toBeNull();
    expect(Object.keys(fieldsOf(collect([{ toString: 1, constructor: 2 }])))).not.toContain(
      "cmcd.toString"
    );
  });

  it("accepts only reverse-DNS custom keys, and never names the ones it refuses", () => {
    const result = collect([{ "acme-latency": 5, "com.liberty-failoverAttempt": 2 }]);
    const fields = fieldsOf(result);

    expect(fields["cmcd.custom.com.liberty-failoverAttempt"]).toBe(2);
    expect(Object.keys(fields)).not.toContain("cmcd.custom.acme-latency");
    expect(result.rejections).toContainEqual({
      reason: "custom_key_not_namespaced",
      key: null,
      count: 1
    });
  });

  it("keeps an unknown key's name out of the log entirely", () => {
    // An unknown key is attacker-controlled string data. Naming it would put
    // unbounded input into a log line and let a client grow the rejection list
    // without limit by sending a fresh nonsense key each time.
    const result = collect([{ "'; DROP TABLE events --": 1 }]);
    expect(JSON.stringify(result)).not.toContain("DROP TABLE");
    expect(result.rejections).toContainEqual({ reason: "unknown_key", key: null, count: 1 });
  });
});

describe("redaction", () => {
  it("redacts every URL-bearing key on the SUCCESS path", () => {
    // The success path is the one that matters: a report that is rejected never
    // reaches a sink anyway, so a redaction that only runs on the error branch
    // protects nothing.
    const result = collect([
      {
        e: "rr",
        ttfb: 40,
        url: SIGNED,
        nor: ["../seg-000013.m4s", SIGNED],
        h: "https://app.example.com/watch/northstar"
      }
    ]);

    expect(result.ok).toBe(true);
    const fields = fieldsOf(result);

    expect(fields["cmcd.url"]).toBe(`https://cdn.example.com/${REDACTED}`);
    expect(fields["cmcd.nor"]).toBe(`${REDACTED},https://cdn.example.com/${REDACTED}`);
    expect(fields["cmcd.h"]).toBe(`https://app.example.com/${REDACTED}`);
    expect(fields["cmcd.ttfbMs"]).toBe(40);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("SECRET-SIGNATURE");
    expect(serialised).not.toContain("northstar");
    expect(serialised).not.toContain("seg-000013");
  });

  it("leaks nothing under ANY registry key, walked exhaustively", () => {
    /*
     * Walks the registry rather than a chosen sample, so a key added to
     * `cmcd-keys.ts` next quarter is covered on the day it is added rather than
     * on the day somebody remembers this test exists. A signed URL is offered
     * under every key in whatever container that key's kind expects.
     */
    for (const [key, keySpec] of Object.entries(CMCD_V2_KEYS)) {
      const value =
        keySpec.kind === "string-list" || keySpec.kind === "number-list" ? [SIGNED] : SIGNED;
      const result = collectCmcdEventReport({
        payload: { events: [{ [key]: value }] },
        receivedAtMs: RECEIVED_AT,
        requestId: null
      });

      const serialised = JSON.stringify(result);
      expect(serialised, key).not.toContain("SECRET-SIGNATURE");
      expect(serialised, key).not.toContain("movies");
      expect(serialised, key).not.toContain("Policy=");
    }
  });

  it("redacts a URL hidden in a key the registry believes is safe", () => {
    // `cid` is ours and should hold a content id, but it arrives over the wire
    // from an untrusted client. The classification being right is not the only
    // thing standing between us and the leak.
    const fields = fieldsOf(collect([{ cid: SIGNED, cmsdd: SIGNED }]));
    expect(fields["cmcd.cid"]).toBe(`https://cdn.example.com/${REDACTED}`);
    expect(fields["cmcd.cmsdd"]).toBe(`https://cdn.example.com/${REDACTED}`);
  });

  it("redacts a URL hidden in a custom key value", () => {
    const fields = fieldsOf(collect([{ "com.liberty-candidate": SIGNED }]));
    expect(fields["cmcd.custom.com.liberty-candidate"]).toBe(
      `https://cdn.example.com/${REDACTED}`
    );
  });

  it("does not quote the offending value when it rejects one", () => {
    // The commonest way for a signed URL to arrive under the wrong type is a
    // client sending `url` as an array; a "expected string, got [...]" message
    // would print it straight into the rejection trail.
    const result = collect([{ url: [SIGNED] }]);
    expect(result.rejections).toContainEqual({ reason: "wrong_type", key: "url", count: 1 });
    expect(JSON.stringify(result.rejections)).not.toContain("cdn.example.com");
  });
});

describe("classification", () => {
  it("names the four events PL-0503's acceptance asks to be observable", () => {
    expect(nameOf(collect([{ e: "ps", sta: "s", msd: 1500 }]))).toBe("playback.cmcd.startup");
    expect(nameOf(collect([{ e: "ps", sta: "r", bs: true }]))).toBe("playback.cmcd.rebuffer");
    expect(nameOf(collect([{ e: "bc" }]))).toBe("playback.cmcd.bitrate_change");
    expect(nameOf(collect([{ e: "e", ec: ["MANIFEST_ERROR"] }]))).toBe("playback.cmcd.error");
  });

  it("treats error codes as a failure even when the client forgot to say so", () => {
    const result = collect([{ e: "t", ec: ["HTTP_ERROR"] }]);
    expect(nameOf(result)).toBe("playback.cmcd.error");
    expect(result.logs[0]?.level).toBe("error");
  });

  it("reads a state without an event type rather than dropping it into other", () => {
    // `sta` is a request-mode key too, so a report can carry a meaningful state
    // with no event type at all. Dropping those would lose rebuffers.
    expect(nameOf(collect([{ sta: "r" }]))).toBe("playback.cmcd.rebuffer");
    expect(nameOf(collect([{ sta: "s" }]))).toBe("playback.cmcd.startup");
  });

  it("logs a failure at error level and everything else at info", () => {
    expect(collect([{ e: "e" }]).logs[0]?.level).toBe("error");
    expect(collect([{ e: "bc" }]).logs[0]?.level).toBe("info");
    expect(collect([{ e: "t" }]).logs[0]?.level).toBe("info");
  });
});

describe("inner lists", () => {
  it("emits object-type slots in the specification's order, not arrival order", () => {
    const arrival = fieldsOf(
      collect([
        { bl: [{ value: 2000, objectType: "a" }, { value: 3000, objectType: "v" }, 1000] }
      ])
    );
    const reversed = fieldsOf(
      collect([
        { bl: [1000, { value: 3000, objectType: "v" }, { value: 2000, objectType: "a" }] }
      ])
    );

    expect(Object.keys(arrival)).toEqual(Object.keys(reversed));
    expect(arrival).toEqual(reversed);
    expect(arrival["cmcd.blMs"]).toBe(1000);
    expect(arrival["cmcd.blMs.a"]).toBe(2000);
    expect(arrival["cmcd.blMs.v"]).toBe(3000);
  });

  it("refuses a second value for a slot instead of letting the last one win", () => {
    // "The last one wins" is an order dependence wearing a different hat.
    const result = collect([
      { bl: [{ value: 1000, objectType: "v" }, { value: 2000, objectType: "v" }] }
    ]);
    expect(fieldsOf(result)["cmcd.blMs.v"]).toBe(1000);
    expect(result.rejections).toContainEqual({
      reason: "duplicate_list_slot",
      key: "bl",
      count: 1
    });
  });

  it("writes null for a non-finite slot rather than dropping it to zero", () => {
    const result = collect([{ bl: [{ value: Number.NaN, objectType: "v" }] }]);
    expect(fieldsOf(result)["cmcd.blMs.v"]).toBeNull();
    expect(result.rejections).toContainEqual({ reason: "not_finite", key: "bl", count: 1 });
  });
});

describe("the boundary itself", () => {
  it("returns a rejected result for a malformed report rather than throwing", () => {
    const input = { payload: "not a report", receivedAtMs: RECEIVED_AT, requestId: null };
    expect(() => collectCmcdEventReport(input)).not.toThrow();
    expect(collectCmcdEventReport(input)).toEqual({
      ok: false,
      logs: [],
      rejections: [{ reason: "payload_not_an_object", key: null, count: 1 }]
    });
  });

  it("reads no clock of its own", () => {
    // A `Date.now()` in here would make the permutation property untestable and
    // the difference invisible.
    const once = collectCmcdEventReport({
      payload: { events: [{ msd: 1500 }] },
      receivedAtMs: 10,
      requestId: null
    });
    const twice = collectCmcdEventReport({
      payload: { events: [{ msd: 1500 }] },
      receivedAtMs: 10,
      requestId: null
    });

    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(fieldsOf(once)["telemetry.receivedAtEpochMs"]).toBe(10);
  });

  it("omits requestId rather than writing undefined when there is none", () => {
    const result = collectCmcdEventReport({
      payload: { events: [{ msd: 1500 }] },
      receivedAtMs: RECEIVED_AT,
      requestId: null
    });
    expect(Object.keys(result.logs[0] ?? {})).not.toContain("requestId");
    expect(collect([{ msd: 1500 }]).logs[0]?.requestId).toBe("req-1");
  });

  it("carries a per-event refusal trail as well as the aggregate", () => {
    const fields = fieldsOf(collect([{ msd: 1.5, nrr: "0-1" }]));
    expect(fields["telemetry.rejectedKeys"]).toBe(2);
    expect(fields["telemetry.rejectReasons"]).toBe("not_an_integer,removed_in_v2");
  });
});

describe("the client allowlist", () => {
  it("offers no URL-bearing key, because it is derived rather than remembered", () => {
    // This is what the player puts in Shaka's `includeKeys`, so the URL-bearing
    // keys are never requested in the first place — a second, independent
    // control over the same leak, from the same declaration.
    for (const key of ["url", "nor", "h"]) {
      expect(CMCD_V2_CLIENT_SAFE_KEYS, key).not.toContain(key);
    }
    for (const key of CMCD_V2_CLIENT_SAFE_KEYS) {
      expect(cmcdKeySpec(key)?.sensitivity, key).toBe("safe");
    }
  });

  it("offers nothing CMCD v2 removed", () => {
    expect(CMCD_V2_CLIENT_SAFE_KEYS).not.toContain("nrr");
  });

  it("is sorted, so the emitted config depends on content and not declaration order", () => {
    expect([...CMCD_V2_CLIENT_SAFE_KEYS]).toEqual([...CMCD_V2_CLIENT_SAFE_KEYS].sort());
  });

  it("still offers the QoE keys the research says we need", () => {
    for (const key of ["msd", "bs", "bsa", "bsd", "bsda", "dfa", "ltc", "sta", "ec", "ttfb", "ttlb"]) {
      expect(CMCD_V2_CLIENT_SAFE_KEYS, key).toContain(key);
    }
  });
});
